import path from "path";
import fs from "fs";

/**
 * Resolves `relative` against `base` and throws if the result escapes `base`.
 * Prevents path traversal attacks (e.g. "../../etc/passwd").
 */
export function safePath(base: string, relative: string): string {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(base, relative);

  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error(
      `Path traversal detected: "${relative}" escapes base "${resolvedBase}"`
    );
  }

  return resolvedTarget;
}

/** Sanitizes a filename from a Matrix media URL or user-provided string. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[^\w.\-]/g, "_")
    .slice(0, 255);
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}
