import { getLogger } from "../logger.js";
import { WorkspaceManager } from "./WorkspaceManager.js";
import { RoomContext } from "./RoomContext.js";
import { LLMProvider } from "../llm/LLMProvider.js";
import { MemoryManager } from "../memory/MemoryManager.js";
import { VectorStore } from "../memory/VectorStore.js";
import { CronEngine } from "../cron/CronEngine.js";
import { getConfig } from "../config.js";
import { roomIdToHash } from "../utils/hash.js";
import { MatrixActions } from "../matrix/MatrixActions.js";
import { KieAIClient } from "../media/KieAIClient.js";

const log = getLogger("RoomManager");

export class RoomManager {
  private readonly rooms = new Map<string, RoomContext>();

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly llm: LLMProvider,
    private readonly vectorStore: VectorStore,
    private readonly cronEngine: CronEngine,
    private readonly actions: MatrixActions,
    private readonly kie: KieAIClient
  ) {}

  getOrCreate(roomId: string): RoomContext {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

    const wsPath = this.workspace.initWorkspace(roomId);
    const hash = roomIdToHash(roomId);
    const roomStore = this.vectorStore.forRoom(hash);
    const memory = new MemoryManager(roomStore, this.workspace, wsPath);
    const context = new RoomContext(
      roomId,
      wsPath,
      this.workspace,
      this.llm,
      memory,
      this.cronEngine,
      this.actions,
      this.kie
    );

    this.rooms.set(roomId, context);
    log.info({ roomId, wsPath }, "Room context created");
    return context;
  }

  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  activeRoomCount(): number {
    return this.rooms.size;
  }
}
