import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub config and anthropic before importing filter
vi.mock("../src/config.js", () => ({
  getConfig: () => ({
    MATRIX_USER_ID: "@bot:example.com",
    BOT_COMMAND_PREFIX: "!",
    REPLY_COOLDOWN_MS: 5000,
    ANTHROPIC_API_KEY: "test-key",
    LOG_LEVEL: "silent",
  }),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => ({
        content: [{ type: "text", text: "NEIN" }],
      }),
    };
  },
}));

import { ShouldReplyFilter } from "../src/filter/ShouldReplyFilter.js";
import type { ParsedMessage } from "../src/matrix/EventRouter.js";

function makeMsg(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    roomId: "!room:example.com",
    eventId: "$event1",
    sender: "@user:example.com",
    body: "Hello",
    timestamp: Date.now(),
    isDM: false,
    isReply: false,
    replyToEventId: undefined,
    ...overrides,
  };
}

describe("ShouldReplyFilter", () => {
  let filter: ShouldReplyFilter;

  beforeEach(() => {
    filter = new ShouldReplyFilter("@bot:example.com");
  });

  it("rejects own messages", async () => {
    const result = await filter.shouldReply(
      makeMsg({ sender: "@bot:example.com" })
    );
    expect(result).toBe(false);
  });

  it("rejects emoji-only messages", async () => {
    const result = await filter.shouldReply(makeMsg({ body: "👍" }));
    expect(result).toBe(false);
  });

  it("accepts direct mention", async () => {
    const result = await filter.shouldReply(
      makeMsg({ body: "@bot:example.com help me" })
    );
    expect(result).toBe(true);
  });

  it("accepts DM unconditionally", async () => {
    const result = await filter.shouldReply(
      makeMsg({ isDM: true, body: "hey" })
    );
    expect(result).toBe(true);
  });

  it("accepts command prefix", async () => {
    const result = await filter.shouldReply(makeMsg({ body: "!help" }));
    expect(result).toBe(true);
  });

  it("accepts question mark", async () => {
    const result = await filter.shouldReply(
      makeMsg({ body: "Wie geht es dir?" })
    );
    expect(result).toBe(true);
  });

  it("accepts question word", async () => {
    const result = await filter.shouldReply(
      makeMsg({ body: "Was ist die Antwort?" })
    );
    expect(result).toBe(true);
  });

  it("rejects short non-question group message", async () => {
    const result = await filter.shouldReply(
      makeMsg({ body: "ok", isDM: false })
    );
    expect(result).toBe(false);
  });
});
