import { getLogger } from "../logger.js";
import { WorkspaceManager, RoomStats } from "./WorkspaceManager.js";
import { LLMProvider } from "../llm/LLMProvider.js";
import { ContextAssembler } from "../llm/ContextAssembler.js";
import { MemoryManager } from "../memory/MemoryManager.js";
import { CronEngine } from "../cron/CronEngine.js";
import { ParsedMessage } from "../matrix/EventRouter.js";
import { getConfig } from "../config.js";

const log = getLogger("RoomContext");

export class RoomContext {
  private messageCount = 0;
  private lastActivityAt = new Date().toISOString();
  private readonly recentMessages: ParsedMessage[] = [];
  private lastReplyAt = 0;

  constructor(
    readonly roomId: string,
    readonly workspacePath: string,
    private readonly workspace: WorkspaceManager,
    private readonly llm: LLMProvider,
    private readonly memory: MemoryManager,
    private readonly cronEngine: CronEngine
  ) {}

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

    if (!shouldReply) return null;

    const config = getConfig();
    const now = Date.now();
    if (now - this.lastReplyAt < config.REPLY_COOLDOWN_MS) {
      log.debug({ roomId: this.roomId }, "Cooldown active, skipping reply");
      return null;
    }
    this.lastReplyAt = now;

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
      return response.text;
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
}
