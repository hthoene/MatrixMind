import http from "http";
import { getConfig } from "./config.js";
import { getLogger } from "./logger.js";
import { MatrixClient } from "./matrix/MatrixClient.js";
import { MatrixActions } from "./matrix/MatrixActions.js";
import {
  confirmPendingAutoVerification,
  getAutoVerificationSnapshot,
} from "./matrix/AutoSessionVerifier.js";
import { EventRouter } from "./matrix/EventRouter.js";
import { WorkspaceManager } from "./room/WorkspaceManager.js";
import { RoomManager } from "./room/RoomManager.js";
import { VectorStore } from "./memory/VectorStore.js";
import { ClaudeCodeProvider } from "./llm/ClaudeCodeProvider.js";
import { AnthropicProvider } from "./llm/AnthropicProvider.js";
import { LLMProvider } from "./llm/LLMProvider.js";
import { ShouldReplyFilter } from "./filter/ShouldReplyFilter.js";
import { CronEngine } from "./cron/CronEngine.js";
import { RateLimiter } from "./utils/RateLimiter.js";
import { KieAIClient } from "./media/KieAIClient.js";

const log = getLogger("main");

async function main(): Promise<void> {
  const config = getConfig();
  log.info("MatrixMind starting up");

  // --- LLM provider selection ---
  let llm: LLMProvider;
  if (config.CLAUDE_CODE_AVAILABLE) {
    const cc = new ClaudeCodeProvider();
    const available = await cc.isAvailable().catch(() => false);
    if (available) {
      log.info("Using ClaudeCodeProvider as primary LLM");
      llm = cc;
    } else {
      log.warn("ClaudeCode unavailable, falling back to AnthropicProvider");
      llm = new AnthropicProvider();
    }
  } else {
    log.info("CLAUDE_CODE_AVAILABLE=false, using AnthropicProvider");
    llm = new AnthropicProvider();
  }

  // --- Core services ---
  const vectorStore = new VectorStore();
  const vectorOk = await vectorStore.healthCheck();
  if (!vectorOk) {
    log.warn("ChromaDB unreachable at startup – memory features degraded");
  }

  const workspace = new WorkspaceManager();
  const cronEngine = new CronEngine();
  const matrixClient = new MatrixClient();
  const actions = new MatrixActions(matrixClient);
  const kie = new KieAIClient();
  const roomManager = new RoomManager(
    workspace,
    llm,
    vectorStore,
    cronEngine,
    actions,
    kie
  );
  const filter = new ShouldReplyFilter(
    config.MATRIX_USER_ID,
    (roomId) => {
      const room = matrixClient.getSDKClient().getRoom(roomId);
      return room?.getMembers().map((m) => m.userId) ?? [];
    },
    (roomId, eventId) => {
      const room = matrixClient.getSDKClient().getRoom(roomId);
      const event = room?.findEventById(eventId);
      return event?.getSender() ?? null;
    }
  );
  const rateLimiter = new RateLimiter(
    config.MAX_REQUESTS_PER_ROOM_PER_MINUTE,
    60_000
  );

  // --- Cron → Matrix bridge ---
  cronEngine.setMessageCallback(async (roomId, message) => {
    await actions.sendText(roomId, message);
  });

  // --- Message routing ---
  const router = new EventRouter(matrixClient);

  router.onMessage(async (msg) => {
    // Skip own messages
    if (msg.sender === config.MATRIX_USER_ID) return;

    // Rate limit per room
    if (!rateLimiter.allow(msg.roomId)) {
      log.warn({ roomId: msg.roomId }, "Rate limit exceeded");
      return;
    }

    const roomCtx = roomManager.getOrCreate(msg.roomId);

    // Load cron jobs for this room's workspace (idempotent)
    cronEngine.loadFromWorkspace(roomCtx.workspacePath);

    const shouldReply = await filter.shouldReply(msg).catch((err) => {
      log.warn({ err }, "ShouldReplyFilter threw, defaulting to NO");
      return false;
    });

    if (shouldReply) {
      await actions.setTyping(msg.roomId, true);
    }

    try {
      const response = await roomCtx.handleMessage(msg, shouldReply);
      if (response) {
        await actions.sendMarkdown(msg.roomId, response);
        await actions.markRead(msg.roomId, msg.eventId);
      }
    } finally {
      if (shouldReply) {
        await actions.setTyping(msg.roomId, false);
      }
    }
  });

  // --- Health check HTTP endpoint ---
  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          rooms: roomManager.activeRoomCount(),
          uptime: process.uptime(),
        })
      );
    } else if (req.url === "/verify" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getAutoVerificationSnapshot()));
    } else if (req.url === "/verify/confirm" && req.method === "POST") {
      const body = await readRequestBody(req);
      const confirm = parseVerificationConfirmation(body);
      if (confirm === null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Expected either JSON {\"confirm\":true|false} or a plain body of yes/no/true/false.",
          })
        );
        return;
      }

      const token = readHeader(req, "x-matrixmind-verify-token");
      const result = confirmPendingAutoVerification(confirm, token);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.ok, message: result.message }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(3000, () => {
    log.info("Health endpoint listening on :3000/health");
  });

  // --- Start Matrix ---
  await matrixClient.start();
  log.info("MatrixMind ready");

  // --- Graceful shutdown ---
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "Shutting down");
    cronEngine.stop();
    healthServer.close();
    await matrixClient.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    log.error({ err }, "Uncaught exception");
  });
  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "Unhandled rejection");
  });
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function parseVerificationConfirmation(body: string): boolean | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  if (/^(yes|y|true|1)$/i.test(trimmed)) return true;
  if (/^(no|n|false|0)$/i.test(trimmed)) return false;

  try {
    const parsed = JSON.parse(trimmed) as { confirm?: unknown };
    if (typeof parsed.confirm === "boolean") return parsed.confirm;
  } catch {
    // fall through
  }

  return null;
}

function readHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

main().catch((err) => {
  // logger may not be initialized yet if config validation failed
  console.error("Fatal startup error:", err);
  process.exit(1);
});
