import crypto from "crypto";

/** Derives a stable, filesystem-safe directory name from a Matrix room ID. */
export function roomIdToHash(roomId: string): string {
  return crypto.createHash("sha256").update(roomId).digest("hex");
}

/** Approximate token count: 4 chars ≈ 1 token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
