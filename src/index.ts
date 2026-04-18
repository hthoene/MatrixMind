import http from "http";
import { getConfig } from "./config.js";
import { getLogger } from "./logger.js";
import { MatrixClient } from "./matrix/MatrixClient.js";
import { MatrixActions } from "./matrix/MatrixActions.js";
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
  const roomManager = new RoomManager(workspace, llm, vectorStore, cronEngine);
  const matrixClient = new MatrixClient();
  const actions = new MatrixActions(matrixClient);
  const filter = new ShouldReplyFilter(config.MATRIX_USER_ID);
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
  const healthServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          rooms: roomManager.activeRoomCount(),
          uptime: process.uptime(),
        })
      );
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

main().catch((err) => {
  // logger may not be initialized yet if config validation failed
  console.error("Fatal startup error:", err);
  process.exit(1);
});
