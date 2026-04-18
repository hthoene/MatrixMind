import { RoomVectorStore, SearchResult } from "./VectorStore.js";
import { WorkspaceManager } from "../room/WorkspaceManager.js";
import { ParsedMessage } from "../matrix/EventRouter.js";
import { getLogger } from "../logger.js";

const log = getLogger("MemoryManager");

const MAX_MEMORY_ENTRIES = 20;

export class MemoryManager {
  constructor(
    private readonly store: RoomVectorStore,
    private readonly workspace: WorkspaceManager,
    private readonly workspacePath: string
  ) {}

  async addMessage(msg: ParsedMessage): Promise<void> {
    try {
      await this.store.addMessage(msg);
    } catch (err) {
      log.warn({ err }, "addMessage to vector store failed");
    }
  }

  async search(query: string, limit = 4): Promise<SearchResult[]> {
    return this.store.search(query, limit);
  }

  async addToLongTermMemory(entry: string): Promise<void> {
    const current = this.readMemoryFile();
    const entries = parseMemoryEntries(current);

    if (entries.length >= MAX_MEMORY_ENTRIES) {
      // Drop oldest (first non-header) entry
      entries.shift();
      log.debug("Memory full, evicting oldest entry");
    }

    entries.push(entry);
    this.writeMemoryFile(entries);

    // Also add to vector store for semantic recall
    await this.store.add(entry, {
      roomHash: "",
      type: "document",
    });
  }

  getMemoryEntryCount(): number {
    const content = this.readMemoryFile();
    return parseMemoryEntries(content).length;
  }

  private readMemoryFile(): string {
    try {
      return this.workspace.readFile(this.workspacePath, "MEMORY.md");
    } catch {
      return "# Long-Term Memory\n";
    }
  }

  private writeMemoryFile(entries: string[]): void {
    const body =
      "# Long-Term Memory\n\n" +
      entries.map((e, i) => `${i + 1}. ${e}`).join("\n");
    this.workspace.writeFile(this.workspacePath, "MEMORY.md", body);
  }
}

function parseMemoryEntries(content: string): string[] {
  const lines = content.split("\n");
  const entries: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\d+\.\s+(.+)$/);
    if (match?.[1]) entries.push(match[1]);
  }
  return entries;
}
