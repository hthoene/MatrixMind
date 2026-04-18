import {
  query,
  type SDKMessage,
  type SDKResultSuccess,
  type SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { LLMProvider, LLMQueryParams, LLMResponse } from "./LLMProvider.js";
import { getLogger } from "../logger.js";

const log = getLogger("ClaudeCodeProvider");

export class ClaudeCodeProvider implements LLMProvider {
  async query(params: LLMQueryParams): Promise<LLMResponse> {
    const toolsUsed: string[] = [];
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const stream = query({
        prompt: params.prompt,
        options: {
          cwd: params.workspacePath,
          env: {
            ...process.env,
            SHELL: process.env.SHELL || "/bin/bash",
          },
          allowedTools: params.allowedTools ?? [
            "Read",
            "Write",
            "Edit",
            "Bash",
            "Glob",
            "Grep",
            "WebSearch",
            "WebFetch",
          ],
        },
      });

      for await (const msg of stream) {
        if (isResultSuccess(msg)) {
          text = msg.result;
          inputTokens += msg.usage.input_tokens;
          outputTokens += msg.usage.output_tokens;
        } else if (isAssistantMessage(msg)) {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              toolsUsed.push(block.name);
            } else if (block.type === "text") {
              text = block.text;
            }
          }
          inputTokens += msg.message.usage.input_tokens;
          outputTokens += msg.message.usage.output_tokens;
        }
      }
    } catch (err) {
      log.error({ err }, "ClaudeCodeProvider query failed");
      throw err;
    }

    return {
      text: text.trim(),
      toolsUsed,
      tokenUsage: { input: inputTokens, output: outputTokens },
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Just check that we can import the package successfully; avoid a real API call.
      const mod = await import("@anthropic-ai/claude-agent-sdk");
      return typeof mod.query === "function";
    } catch {
      return false;
    }
  }
}

function isResultSuccess(msg: SDKMessage): msg is SDKResultSuccess {
  return msg.type === "result" && (msg as SDKResultSuccess).subtype === "success";
}

function isAssistantMessage(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === "assistant";
}
