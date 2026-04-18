import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { safePath, sanitizeFilename } from "../src/utils/safePath.js";

describe("safePath", () => {
  const base = path.resolve("/app/workspaces/abc");

  it("allows valid relative paths", () => {
    expect(safePath(base, "SOUL.md")).toBe(path.join(base, "SOUL.md"));
    expect(safePath(base, "skills/foo.md")).toBe(path.join(base, "skills", "foo.md"));
  });

  it("throws on path traversal", () => {
    expect(() => safePath(base, "../../etc/passwd")).toThrow("Path traversal");
  });

  it("throws on absolute path injection", () => {
    const absolute = path.resolve("/etc/passwd");
    expect(() => safePath(base, absolute)).toThrow("Path traversal");
  });
});

describe("sanitizeFilename", () => {
  it("strips directory separators", () => {
    expect(sanitizeFilename("../../evil.sh")).not.toContain("/");
    expect(sanitizeFilename("../../evil.sh")).not.toContain("\\");
    expect(sanitizeFilename("../../evil.sh")).not.toContain("..");
  });

  it("preserves normal filenames", () => {
    expect(sanitizeFilename("photo.jpg")).toBe("photo.jpg");
  });

  it("truncates long names", () => {
    const long = "a".repeat(300);
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(255);
  });
});

describe("WorkspaceManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrixmind-test-"));
    process.env["MATRIX_HOMESERVER_URL"] = "https://matrix.example.com";
    process.env["MATRIX_ACCESS_TOKEN"] = "syt_test";
    process.env["MATRIX_USER_ID"] = "@bot:example.com";
    process.env["ANTHROPIC_API_KEY"] = "test";
    process.env["WORKSPACES_DIR"] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates isolated workspace per room", async () => {
    const { WorkspaceManager } = await import("../src/room/WorkspaceManager.js");
    const wm = new WorkspaceManager();
    const p1 = wm.initWorkspace("!room1:server.de");
    const p2 = wm.initWorkspace("!room2:server.de");
    expect(p1).not.toBe(p2);
    expect(fs.existsSync(path.join(p1, "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(p2, "SOUL.md"))).toBe(true);
  });

  it("workspace path uses hash not room ID", async () => {
    const { WorkspaceManager } = await import("../src/room/WorkspaceManager.js");
    const wm = new WorkspaceManager();
    const wsPath = wm.initWorkspace("!room:server.de");
    expect(wsPath).not.toContain("!room");
    expect(wsPath).not.toContain("server.de");
  });
});
