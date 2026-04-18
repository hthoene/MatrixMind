import Anthropic from "@anthropic-ai/sdk";
import { ParsedMessage } from "../matrix/EventRouter.js";
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";

const log = getLogger("ShouldReplyFilter");

const QUESTION_WORDS_DE = ["wer", "was", "wie", "wann", "warum", "welche", "welcher", "welches", "wo", "wohin", "woher"];
const QUESTION_WORDS_EN = ["who", "what", "how", "when", "why", "which", "where", "can", "could", "would", "should", "is", "are", "do", "does", "will"];

const KNOWN_BOT_PATTERNS = [/bot$/i, /assistant$/i, /-bot:/i];

export type ReplyDecision = "YES" | "NO" | "UNCERTAIN";

export class ShouldReplyFilter {
  private readonly botUserId: string;
  private readonly commandPrefix: string;
  private anthropic: Anthropic | null = null;

  constructor(botUserId: string) {
    const config = getConfig();
    this.botUserId = botUserId;
    this.commandPrefix = config.BOT_COMMAND_PREFIX;
  }

  async shouldReply(msg: ParsedMessage): Promise<boolean> {
    // Stage 1: rule-based
    const stage1 = this.stage1(msg);
    if (stage1 === "YES") return true;
    if (stage1 === "NO") return false;

    // Stage 2: heuristic
    const stage2 = this.stage2(msg);
    if (stage2 === "YES") return true;
    if (stage2 === "NO") return false;

    // Stage 3: Haiku classifier
    return this.stage3(msg);
  }

  private stage1(msg: ParsedMessage): ReplyDecision {
    if (msg.sender === this.botUserId) return "NO";

    const body = msg.body.trim();
    if (/^[\p{Emoji}]+$/u.test(body)) return "NO";
    if (KNOWN_BOT_PATTERNS.some((p) => p.test(msg.sender))) return "NO";

    if (msg.body.includes(`@${this.botUserId}`) || msg.body.includes(this.botUserId.split(":")[0]?.replace("@", "") ?? "")) {
      return "YES";
    }
    if (msg.isDM) return "YES";
    if (body.startsWith(this.commandPrefix) || body.startsWith("/")) return "YES";

    return "UNCERTAIN";
  }

  private stage2(msg: ParsedMessage): ReplyDecision {
    const body = msg.body.trim().toLowerCase();

    if (body.endsWith("?")) return "YES";

    const words = body.split(/\s+/);
    const firstWord = words[0] ?? "";
    if (
      QUESTION_WORDS_DE.includes(firstWord) ||
      QUESTION_WORDS_EN.includes(firstWord)
    ) {
      return "YES";
    }

    // Very short message in group without question → no
    if (!msg.isDM && body.length < 20) return "NO";

    return "UNCERTAIN";
  }

  private async stage3(msg: ParsedMessage): Promise<boolean> {
    try {
      const client = this.getAnthropicClient();
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        messages: [
          {
            role: "user",
            content: `Antworte nur mit JA oder NEIN: Erwartet diese Nachricht eine Antwort von einem Assistenten?\n\n"${msg.body.slice(0, 500)}"`,
          },
        ],
      });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("")
        .trim()
        .toUpperCase();
      const result = text.startsWith("JA") || text.startsWith("YES");
      log.debug({ result, body: msg.body.slice(0, 100) }, "Stage-3 Haiku decision");
      return result;
    } catch (err) {
      log.warn({ err }, "Stage-3 Haiku check failed, defaulting to NO");
      return false;
    }
  }

  private getAnthropicClient(): Anthropic {
    if (!this.anthropic) {
      const config = getConfig();
      this.anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    }
    return this.anthropic;
  }
}
