import { describe, it, expect } from "vitest";
import { estimateTokens } from "../src/utils/hash.js";
import { roomIdToHash } from "../src/utils/hash.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("approximates 1 token per 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("roomIdToHash", () => {
  it("produces a hex string", () => {
    const h = roomIdToHash("!abc:server.de");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(roomIdToHash("!x:y")).toBe(roomIdToHash("!x:y"));
  });

  it("differs for different room IDs", () => {
    expect(roomIdToHash("!a:x")).not.toBe(roomIdToHash("!b:x"));
  });
});
