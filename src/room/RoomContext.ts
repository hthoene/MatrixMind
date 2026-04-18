import path from "node:path";
import { getLogger } from "../logger.js";
import { WorkspaceManager, RoomStats } from "./WorkspaceManager.js";
import { LLMProvider } from "../llm/LLMProvider.js";
import { ContextAssembler } from "../llm/ContextAssembler.js";
import { MemoryManager } from "../memory/MemoryManager.js";
import { CronEngine } from "../cron/CronEngine.js";
import { ParsedMessage } from "../matrix/EventRouter.js";
import { getConfig } from "../config.js";
import { MatrixActions } from "../matrix/MatrixActions.js";
import { KieAIClient } from "../media/KieAIClient.js";
import { safePath } from "../utils/safePath.js";

const log = getLogger("RoomContext");

export class RoomContext {
  private messageCount = 0;
  private lastActivityAt = new Date().toISOString();
  private readonly recentMessages: ParsedMessage[] = [];
  private lastReplyAt = 0;
  private readonly commandPrefix: string;
  private historyLoaded = false;

  constructor(
    readonly roomId: string,
    readonly workspacePath: string,
    private readonly workspace: WorkspaceManager,
    private readonly llm: LLMProvider,
    private readonly memory: MemoryManager,
    private readonly cronEngine: CronEngine,
    private readonly actions: MatrixActions,
    private readonly kie: KieAIClient
  ) {
    this.commandPrefix = getConfig().BOT_COMMAND_PREFIX;
  }

  async handleMessage(
    msg: ParsedMessage,
    shouldReply: boolean
  ): Promise<string | null> {
    this.messageCount++;
    this.lastActivityAt = new Date().toISOString();
    this.recentMessages.push(msg);
    if (this.recentMessages.length > 50) this.recentMessages.shift();

    // Always embed the message into vector memory
    try {
      await this.memory.addMessage(msg);
    } catch (err) {
      log.warn({ err, roomId: this.roomId }, "Memory embed failed");
    }

    const command = this.parseCommand(msg.body);
    if (command) {
      try {
        return await this.handleCommand(command);
      } catch (err) {
        log.error({ err, roomId: this.roomId, command: command.kind }, "Media command failed");
        return `Befehl fehlgeschlagen: ${toErrorMessage(err)}`;
      }
    }

    if (!shouldReply) return null;

    const config = getConfig();
    const now = Date.now();
    if (now - this.lastReplyAt < config.REPLY_COOLDOWN_MS) {
      log.debug({ roomId: this.roomId }, "Cooldown active, skipping reply");
      return null;
    }
    this.lastReplyAt = now;

    if (!this.historyLoaded) {
      this.historyLoaded = true;
      await this.loadHistoryFromMatrix();
    }

    const assembler = new ContextAssembler(
      this.workspace,
      this.memory,
      this.workspacePath
    );
    const prompt = await assembler.build(msg, this.recentMessages);

    try {
      const response = await this.llm.query({
        prompt,
        workspacePath: this.workspacePath,
      });
      this.updateContextFile();
      await this.handleMediaMarkers(response.text);
      const stripped = stripMediaMarkers(response.text);
      if (stripped) {
        this.pushBotMessage(stripped);
      }
      return stripped || null;
    } catch (err) {
      log.error({ err, roomId: this.roomId }, "LLM query failed");
      return null;
    }
  }

  getStats(): RoomStats {
    return {
      messageCount: this.messageCount,
      lastActivity: this.lastActivityAt,
      memberCount: 0,
    };
  }

  private updateContextFile(): void {
    try {
      this.workspace.updateContextFile(
        this.workspacePath,
        this.roomId,
        this.getStats()
      );
    } catch (err) {
      log.warn({ err }, "updateContextFile failed");
    }
  }

  private async handleCommand(command: BotCommand): Promise<string | null> {
    switch (command.kind) {
      case "image":
        if (!command.prompt) {
          return `Verwendung: \`${this.commandPrefix}image <prompt>\``;
        }
        if (!this.kie.isConfigured()) {
          return "Kie.ai ist noch nicht konfiguriert. Setze `KIE_AI_API_KEY` in der `.env` und starte den Bot neu.";
        }
        await this.actions.sendText(this.roomId, "Erzeuge Bild...");
        try {
          const result = await this.kie.generateImage(this.workspacePath, command.prompt);
          await this.actions.sendImage(this.roomId, result.localPath);
          return `Bild erstellt und gesendet. Datei: \`${result.relativePath}\``;
        } catch (err) {
          log.error({ err, roomId: this.roomId }, "Image generation failed");
          return `Bildgenerierung fehlgeschlagen: ${toErrorMessage(err)}`;
        }

      case "video":
        if (!command.prompt) {
          return `Verwendung: \`${this.commandPrefix}video <prompt>\``;
        }
        if (!this.kie.isConfigured()) {
          return "Kie.ai ist noch nicht konfiguriert. Setze `KIE_AI_API_KEY` in der `.env` und starte den Bot neu.";
        }
        await this.actions.sendText(this.roomId, "Erzeuge Video...");
        try {
          const result = await this.kie.generateVideo(this.workspacePath, command.prompt);
          await this.actions.sendVideo(this.roomId, result.localPath);
          return `Video erstellt und gesendet. Datei: \`${result.relativePath}\``;
        } catch (err) {
          log.error({ err, roomId: this.roomId }, "Video generation failed");
          return `Videogenerierung fehlgeschlagen: ${toErrorMessage(err)}`;
        }

      case "send-image": {
        const localPath = this.resolveWorkspacePath(command.relativePath);
        await this.actions.sendImage(this.roomId, localPath);
        return `Bild gesendet: \`${normalizeRelativePath(this.workspacePath, localPath)}\``;
      }

      case "send-video": {
        const localPath = this.resolveWorkspacePath(command.relativePath);
        await this.actions.sendVideo(this.roomId, localPath);
        return `Video gesendet: \`${normalizeRelativePath(this.workspacePath, localPath)}\``;
      }

      case "send-file": {
        const localPath = this.resolveWorkspacePath(command.relativePath);
        await this.actions.sendFile(this.roomId, localPath);
        return `Datei gesendet: \`${normalizeRelativePath(this.workspacePath, localPath)}\``;
      }

      case "media-help":
        return [
          "Verfuegbare Medienbefehle:",
          `- \`${this.commandPrefix}image <prompt>\` erzeugt ein Bild ueber Kie.ai und sendet es in Matrix.`,
          `- \`${this.commandPrefix}video <prompt>\` erzeugt ein Video ueber Kie.ai und sendet es in Matrix.`,
          `- \`${this.commandPrefix}send image <relativer-pfad>\` sendet ein Bild aus dem Workspace.`,
          `- \`${this.commandPrefix}send video <relativer-pfad>\` sendet ein Video aus dem Workspace.`,
          `- \`${this.commandPrefix}send file <relativer-pfad>\` sendet eine Datei aus dem Workspace.`,
        ].join("\n");
    }
  }

  private parseCommand(body: string): BotCommand | null {
    const trimmed = body.trim();
    const withoutPrefix = stripCommandPrefix(trimmed, this.commandPrefix);
    if (!withoutPrefix) return null;

    const lower = withoutPrefix.toLowerCase();
    if (lower === "media" || lower === "help media" || lower === "hilfe medien") {
      return { kind: "media-help" };
    }

    const imagePrompt = matchRemainder(withoutPrefix, ["image", "img", "bild"]);
    if (imagePrompt !== null) return { kind: "image", prompt: imagePrompt };

    const videoPrompt = matchRemainder(withoutPrefix, ["video", "clip"]);
    if (videoPrompt !== null) return { kind: "video", prompt: videoPrompt };

    const sendImage = matchSubcommandRemainder(withoutPrefix, "send", ["image", "bild"]);
    if (sendImage) return { kind: "send-image", relativePath: sendImage };

    const sendVideo = matchSubcommandRemainder(withoutPrefix, "send", ["video"]);
    if (sendVideo) return { kind: "send-video", relativePath: sendVideo };

    const sendFile = matchSubcommandRemainder(withoutPrefix, "send", ["file", "datei"]);
    if (sendFile) return { kind: "send-file", relativePath: sendFile };

    return null;
  }

  private async handleMediaMarkers(text: string): Promise<void> {
    const fileMatches = [...text.matchAll(/\[FILE:\s*([^\]]+)\]/gi)];
    for (const match of fileMatches) {
      const relativePath = (match[1] ?? "").trim();
      try {
        const localPath = this.resolveWorkspacePath(relativePath);
        await this.actions.sendFile(this.roomId, localPath);
      } catch (err) {
        log.error({ err, roomId: this.roomId }, "LLM-triggered file send failed");
        await this.actions.sendText(this.roomId, `Datei konnte nicht gesendet werden: ${toErrorMessage(err)}`);
      }
    }

    if (!this.kie.isConfigured()) return;

    const imageMatches = [...text.matchAll(/\[IMAGE:\s*([^\]]+)\]/gi)];
    for (const match of imageMatches) {
      const prompt = (match[1] ?? "").trim();
      try {
        const result = await this.kie.generateImage(this.workspacePath, prompt);
        await this.actions.sendImage(this.roomId, result.localPath);
      } catch (err) {
        log.error({ err, roomId: this.roomId }, "LLM-triggered image generation failed");
        await this.actions.sendText(this.roomId, `Bildgenerierung fehlgeschlagen: ${toErrorMessage(err)}`);
      }
    }

    const videoMatches = [...text.matchAll(/\[VIDEO:\s*([^\]]+)\]/gi)];
    for (const match of videoMatches) {
      const prompt = (match[1] ?? "").trim();
      try {
        const result = await this.kie.generateVideo(this.workspacePath, prompt);
        await this.actions.sendVideo(this.roomId, result.localPath);
      } catch (err) {
        log.error({ err, roomId: this.roomId }, "LLM-triggered video generation failed");
        await this.actions.sendText(this.roomId, `Videogenerierung fehlgeschlagen: ${toErrorMessage(err)}`);
      }
    }
  }

  private async loadHistoryFromMatrix(): Promise<void> {
    try {
      const existing = new Set(this.recentMessages.map((m) => m.eventId));
      const fetched = await this.actions.fetchRecentMessages(this.roomId, 20);
      const toInsert: ParsedMessage[] = fetched
        .filter((e) => !existing.has(e.eventId))
        .map((e) => ({
          roomId: this.roomId,
          eventId: e.eventId,
          sender: e.sender,
          body: e.body,
          timestamp: e.timestamp,
          isDM: false,
          isReply: false,
          replyToEventId: undefined,
        }));

      this.recentMessages.unshift(...toInsert);
      while (this.recentMessages.length > 50) this.recentMessages.shift();
      log.debug({ roomId: this.roomId, loaded: toInsert.length }, "History loaded from Matrix");
    } catch (err) {
      log.warn({ err, roomId: this.roomId }, "loadHistoryFromMatrix failed");
    }
  }

  private pushBotMessage(text: string): void {
    const botMsg: ParsedMessage = {
      roomId: this.roomId,
      eventId: `bot-${Date.now()}`,
      sender: getConfig().MATRIX_USER_ID,
      body: text,
      timestamp: Date.now(),
      isDM: false,
      isReply: false,
      replyToEventId: undefined,
    };
    this.recentMessages.push(botMsg);
    if (this.recentMessages.length > 50) this.recentMessages.shift();
  }

  private resolveWorkspacePath(relativePath: string): string {
    const resolved = safePath(this.workspacePath, relativePath);
    if (!this.workspace.fileExists(this.workspacePath, relativePath)) {
      throw new Error(`Datei nicht gefunden: ${relativePath}`);
    }
    return resolved;
  }
}

type BotCommand =
  | { kind: "image"; prompt: string }
  | { kind: "video"; prompt: string }
  | { kind: "send-image"; relativePath: string }
  | { kind: "send-video"; relativePath: string }
  | { kind: "send-file"; relativePath: string }
  | { kind: "media-help" };

function stripCommandPrefix(body: string, prefix: string): string | null {
  if (body.startsWith(prefix)) return body.slice(prefix.length).trim();
  if (body.startsWith("/")) return body.slice(1).trim();
  return null;
}

function matchRemainder(body: string, commands: string[]): string | null {
  for (const command of commands) {
    if (body.toLowerCase() === command.toLowerCase()) return "";
    if (body.toLowerCase().startsWith(`${command.toLowerCase()} `)) {
      return body.slice(command.length).trim();
    }
  }
  return null;
}

function matchSubcommandRemainder(
  body: string,
  command: string,
  subcommands: string[]
): string | null {
  if (!body.toLowerCase().startsWith(`${command.toLowerCase()} `)) return null;

  const remainder = body.slice(command.length).trim();
  for (const subcommand of subcommands) {
    if (remainder.toLowerCase().startsWith(`${subcommand.toLowerCase()} `)) {
      return remainder.slice(subcommand.length).trim();
    }
  }

  return null;
}

function normalizeRelativePath(workspacePath: string, absolutePath: string): string {
  return path.relative(workspacePath, absolutePath).replace(/\\/g, "/");
}

function stripMediaMarkers(text: string): string {
  return text.replace(/\[(IMAGE|VIDEO|FILE):\s*[^\]]+\]/gi, "").trim();
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unbekannter Fehler";
}
