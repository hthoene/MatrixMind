import { WorkspaceManager } from "../room/WorkspaceManager.js";
import { MemoryManager } from "../memory/MemoryManager.js";
import { ParsedMessage } from "../matrix/EventRouter.js";
import { estimateTokens } from "../utils/hash.js";
import { getLogger } from "../logger.js";

const log = getLogger("ContextAssembler");

const BUDGET = {
  soul: 500,
  memory: 300,
  vectorRecall: 600,
  recentMessages: 800,
  currentMessage: 300,
};

export class ContextAssembler {
  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly memory: MemoryManager,
    private readonly workspacePath: string
  ) {}

  async build(
    current: ParsedMessage,
    recentHistory: ParsedMessage[]
  ): Promise<string> {
    const soul = this.loadTruncated("SOUL.md", BUDGET.soul);
    const memoryMd = this.loadTruncated("MEMORY.md", BUDGET.memory);
    const vectorRecall = await this.fetchVectorRecall(current.body);
    const history = this.buildHistorySection(recentHistory, current);

    const now = new Date().toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      dateStyle: "full",
      timeStyle: "medium",
    });

    return [
      "## System\n" + soul + `\n\nAktuelle Uhrzeit: ${now}`,
      "## Long-Term Memory\n" + memoryMd,
      vectorRecall ? "## Related Context (from memory)\n" + vectorRecall : "",
      "## Recent Conversation\n" + history,
      "## Current Message\n" +
        `${current.sender}: ${truncateToTokens(current.body, BUDGET.currentMessage)}`,
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");
  }

  private loadTruncated(file: string, maxTokens: number): string {
    try {
      const content = this.workspace.readFile(this.workspacePath, file);
      return truncateToTokens(content, maxTokens);
    } catch (err) {
      log.warn({ err, file }, "Could not load workspace file");
      return "";
    }
  }

  private async fetchVectorRecall(query: string): Promise<string> {
    try {
      const results = await this.memory.search(query, 4);
      const texts = results.map((r) => `- ${r.content}`).join("\n");
      return truncateToTokens(texts, BUDGET.vectorRecall);
    } catch (err) {
      log.warn({ err }, "Vector recall failed");
      return "";
    }
  }

  private buildHistorySection(
    history: ParsedMessage[],
    current: ParsedMessage
  ): string {
    const relevant = history
      .filter((m) => m.eventId !== current.eventId)
      .slice(-10);

    const lines = relevant.map((m) => `${m.sender}: ${m.body}`).join("\n");
    return truncateToTokens(lines, BUDGET.recentMessages);
  }
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = maxTokens * 4;
  return text.slice(0, maxChars) + "\n…[truncated]";
}
