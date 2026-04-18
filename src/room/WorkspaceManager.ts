import fs from "fs";
import path from "path";
import { safePath, sanitizeFilename, ensureDir } from "../utils/safePath.js";
import { roomIdToHash } from "../utils/hash.js";
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";

const log = getLogger("WorkspaceManager");

const DEFAULT_SOUL = `# Identity
Du bist MatrixMind, ein intelligenter, minimalistischer Assistent.
Du bist präzise, hilfreich und ehrlich. Du antwortest auf Deutsch
wenn der User Deutsch schreibt, sonst in der Sprache des Users.

# Verhalten
- Antworte nur wenn du wirklich etwas Sinnvolles beitragen kannst.
- Sei prägnant. Kein Fülltext, keine unnötigen Höflichkeitsfloskeln.
- Wenn du dir unsicher bist, sage das offen.

# Gedächtnis-Regeln
- MEMORY.md enthält maximal 20 Einträge.
- Speichere nur dauerhaft relevante Fakten: Präferenzen, Namen, Kernentscheidungen.
- Niemals Gesprächsverläufe in MEMORY.md schreiben.
- Wenn du etwas speichern willst und MEMORY.md voll ist:
  entferne den unwichtigsten Eintrag zuerst.
- Alles andere lebt in der Vektordatenbank.

# Skills
- Deine verfügbaren Skills findest du in ./skills/
- Du kannst neue Skills anlegen wenn es sinnvoll ist.
- Skills sind Markdown-Dateien mit einer klaren Aufgabenbeschreibung.

# Wichtig
- Du hast Zugriff auf Web Search (eingebaut in Claude Code).
- Du kannst Python und Bash ausführen.
- Du kannst Dateien lesen und schreiben.
- Dein Arbeitsverzeichnis ist ausschließlich dieser Workspace.
`;

const DEFAULT_MEMORY = `# Long-Term Memory
(empty – memories will be added here automatically)
`;

export class WorkspaceManager {
  private readonly baseDir: string;

  constructor() {
    const config = getConfig();
    this.baseDir = path.resolve(config.WORKSPACES_DIR);
    ensureDir(this.baseDir);
  }

  getWorkspacePath(roomId: string): string {
    const hash = roomIdToHash(roomId);
    return path.join(this.baseDir, hash);
  }

  initWorkspace(roomId: string): string {
    const wsPath = this.getWorkspacePath(roomId);
    if (fs.existsSync(wsPath)) return wsPath;

    log.info({ roomId }, "Initializing new workspace");
    ensureDir(wsPath);
    ensureDir(path.join(wsPath, "skills", "defaults"));
    ensureDir(path.join(wsPath, "files"));
    ensureDir(path.join(wsPath, "scripts"));
    ensureDir(path.join(wsPath, ".cron"));

    this.writeFile(wsPath, "SOUL.md", DEFAULT_SOUL);
    this.writeFile(wsPath, "MEMORY.md", DEFAULT_MEMORY);
    this.writeFile(wsPath, "CONTEXT.md", buildContextFile(roomId));

    log.info({ wsPath }, "Workspace initialized");
    return wsPath;
  }

  readFile(workspacePath: string, relative: string): string {
    const full = safePath(workspacePath, relative);
    return fs.readFileSync(full, "utf-8");
  }

  writeFile(workspacePath: string, relative: string, content: string): void {
    const full = safePath(workspacePath, relative);
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, content, "utf-8");
  }

  fileExists(workspacePath: string, relative: string): boolean {
    try {
      const full = safePath(workspacePath, relative);
      return fs.existsSync(full);
    } catch {
      return false;
    }
  }

  listFiles(workspacePath: string, subdir: string): string[] {
    const full = safePath(workspacePath, subdir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full).filter((f) => !f.startsWith("."));
  }

  saveReceivedFile(
    workspacePath: string,
    rawFilename: string,
    content: Buffer
  ): string {
    const safe = sanitizeFilename(rawFilename);
    const dest = safePath(workspacePath, `files/${safe}`);
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, content);
    return dest;
  }

  updateContextFile(workspacePath: string, roomId: string, stats: RoomStats): void {
    const content = buildContextFileWithStats(roomId, stats);
    this.writeFile(workspacePath, "CONTEXT.md", content);
  }
}

export interface RoomStats {
  messageCount: number;
  lastActivity: string;
  memberCount: number;
}

function buildContextFile(roomId: string): string {
  return buildContextFileWithStats(roomId, {
    messageCount: 0,
    lastActivity: new Date().toISOString(),
    memberCount: 0,
  });
}

function buildContextFileWithStats(roomId: string, stats: RoomStats): string {
  return `# Room Context
Generated: ${new Date().toISOString()}

## Room ID
${roomId}

## Statistics
- Messages processed: ${stats.messageCount}
- Last activity: ${stats.lastActivity}
- Member count: ${stats.memberCount}
`;
}
