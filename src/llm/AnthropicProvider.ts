import Anthropic from "@anthropic-ai/sdk";
import { LLMProvider, LLMQueryParams, LLMResponse } from "./LLMProvider.js";
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";

const log = getLogger("AnthropicProvider");

const MODEL = "claude-sonnet-4-6";

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;

  constructor() {
    const config = getConfig();
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }

  async query(params: LLMQueryParams): Promise<LLMResponse> {
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        messages: [{ role: "user", content: params.prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n")
        .trim();

      return {
        text,
        toolsUsed: [],
        tokenUsage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
      };
    } catch (err) {
      log.error({ err }, "AnthropicProvider query failed");
      throw err;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      return true;
    } catch {
      return false;
    }
  }
}
