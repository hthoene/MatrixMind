# MatrixMind

An intelligent, room-isolated Matrix bot powered by the Claude Code SDK.

Every Matrix room gets its own personality (`SOUL.md`), long-term memory (`MEMORY.md`), vector database collection, and cron jobs. No room can access data from another – this is enforced architecturally, not just by convention.

---

## Quick Start

```bash
# 1. Copy and fill in environment variables
cp .env.example .env
$EDITOR .env

# 2. Start ChromaDB + bot
docker compose up --build
```

The bot is ready when you see `MatrixMind ready` in the logs.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MATRIX_HOMESERVER_URL` | yes | – | e.g. `https://matrix.example.com` |
| `MATRIX_ACCESS_TOKEN` | yes | – | Bot access token (`syt_...`) |
| `MATRIX_USER_ID` | yes | – | e.g. `@matrixmind:example.com` |
| `ANTHROPIC_API_KEY` | yes | – | `sk-ant-...` |
| `CLAUDE_CODE_AVAILABLE` | no | `true` | Set to `false` to force direct API fallback |
| `CHROMADB_URL` | no | `http://chromadb:8000` | ChromaDB endpoint |
| `BOT_COMMAND_PREFIX` | no | `!` | Prefix that always triggers the bot |
| `REPLY_COOLDOWN_MS` | no | `5000` | Min ms between replies per room |
| `MAX_REQUESTS_PER_ROOM_PER_MINUTE` | no | `10` | Rate limit per room |
| `PYTHON_EXECUTION_TIMEOUT_MS` | no | `30000` | Timeout for Claude Code subprocesses |
| `LOG_LEVEL` | no | `info` | `trace`\|`debug`\|`info`\|`warn`\|`error` |
| `WORKSPACES_DIR` | no | `./workspaces` | Where room workspaces are stored |

---

## Architecture

```
src/
├── index.ts              Startup, wires all services together
├── config.ts             Zod-validated env config (single source of truth)
├── logger.ts             Pino structured logger
├── matrix/
│   ├── MatrixClient.ts   Wraps matrix-js-sdk, emits timeline events
│   ├── EventRouter.ts    Parses m.room.message events, deduplicates
│   └── MatrixActions.ts  send/edit/react/typing/file operations
├── room/
│   ├── RoomManager.ts    Registry – one RoomContext per room, lazy init
│   ├── RoomContext.ts    Per-room state, orchestrates LLM + memory
│   └── WorkspaceManager.ts  Filesystem ops with safePath() enforcement
├── llm/
│   ├── LLMProvider.ts    Interface (query / isAvailable)
│   ├── ClaudeCodeProvider.ts  Primary – Claude Code SDK, cwd=workspace
│   ├── AnthropicProvider.ts   Fallback – direct Anthropic API
│   └── ContextAssembler.ts   Builds token-budgeted prompt
├── memory/
│   ├── VectorStore.ts    ChromaDB client; forRoom() is the only entry point
│   └── MemoryManager.ts  Chunking, embedding, recall, MEMORY.md management
├── filter/
│   └── ShouldReplyFilter.ts  3-stage filter (rules → heuristics → Haiku)
├── cron/
│   ├── CronEngine.ts     node-cron wrapper, per-workspace job registry
│   └── CronStore.ts      SQLite persistence (.cron/jobs.db per workspace)
├── skills/
│   └── SkillLoader.ts    Keyword-matched skill loading from workspace
└── utils/
    ├── safePath.ts       Path traversal prevention + filename sanitization
    ├── hash.ts           roomIdToHash (SHA-256), token estimator
    └── RateLimiter.ts    Sliding-window rate limiter per room
```

### LLM Provider Selection

At startup the bot probes whether Claude Code SDK is functional. If yes it runs every room query with `cwd` set to that room's workspace – giving the LLM full tool access (Read, Write, Bash, WebSearch, etc.) scoped to the workspace directory. If unavailable, it falls back to a direct `claude-sonnet-4-6` API call.

### Reply Decision (ShouldReplyFilter)

1. **Rules** (no API call): reject own messages, emoji-only, known bots; accept @mention, DM, command prefix.
2. **Heuristics** (no API call): question mark, question words, message length.
3. **Haiku classifier** (1 API call, only when 1+2 are inconclusive): `claude-haiku-4-5` answers YES/NO.

Regardless of whether the bot replies, every message is embedded into ChromaDB.

### Room Isolation

- Workspace directory name = `SHA-256(roomId)` – never the raw room ID.
- `safePath(base, relative)` throws on any path that escapes the workspace root.
- `VectorStore.forRoom(hash)` returns a `RoomVectorStore` bound to one ChromaDB collection. There is no method to query across collections.
- `CronStore` lives at `{workspace}/.cron/jobs.db` – one SQLite file per room.

### Memory Architecture

```
Prompt budget (≈2500 tokens total):
  SOUL.md          500 tokens  always included
  MEMORY.md        300 tokens  always included (max 20 curated entries)
  Vector recall    600 tokens  top-4 semantically similar chunks
  Recent messages  800 tokens  last 10 messages
  Current message  300 tokens
```

---

## Development

```bash
npm install
npm run dev        # ts-node hot reload
npm run typecheck  # tsc --noEmit
npm run test       # vitest
npm run build      # compile to dist/
```

---

## Adding a Skill

Drop a Markdown file into a room's workspace `skills/` directory:

```markdown
# weather
Query current weather for a city using web search and return a summary.
```

The bot will load this skill when a user message contains keywords that match the file content.

---

## Adding a Cron Job

From within a conversation, the bot can create cron jobs by writing to its `CronStore`. Jobs survive container restarts (stored in SQLite). Example job structure:

```json
{
  "id": "uuid",
  "cronExpression": "0 9 * * 1",
  "message": "Reminder: Weekly Review",
  "roomId": "!abc:server.de",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

---

## Security Checklist

- [x] `safePath()` prevents path traversal in all workspace operations
- [x] Room directory name is SHA-256 hash, never raw room ID
- [x] `RoomVectorStore` has no cross-room read methods
- [x] Container runs as `uid=1001` (non-root)
- [x] All secrets via environment variables only
- [x] Incoming filenames sanitized before storage (`sanitizeFilename`)
- [x] Rate limiting: configurable max requests per room per minute
- [x] Claude Code `cwd` = workspace root (tool access stays sandboxed)
