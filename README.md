# MatrixMind

An intelligent, room-isolated Matrix bot powered by the Claude Code SDK and Anthropic API.

Every Matrix room gets its own sandboxed environment: a personality file (`SOUL.md`), long-term memory (`MEMORY.md`), a dedicated vector database collection, and cron jobs. No room can access data from another — this is enforced architecturally, not just by convention.

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

## E2EE / Session Verification

MatrixMind uses full end-to-end encryption via matrix-js-sdk's Rust crypto.

**Recommended (headless):** set `MATRIX_RECOVERY_KEY` in `.env`. On startup the bot unlocks its Secret Storage automatically and cross-signs its own device — no emoji comparison needed.

**Without a recovery key:** the bot starts an interactive SAS flow:
- sends a verification request to your most recently active own Element device
- prints the SAS emojis into the container logs
- logs a one-time `curl` command to confirm or reject

```bash
curl -X POST http://localhost:3000/verify/confirm \
  -H "Content-Type: application/json" \
  -H "X-MatrixMind-Verify-Token: <token-from-log>" \
  -d '{"confirm":true}'
```

Verification state is written to `workspaces/verify-status.json`.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MATRIX_HOMESERVER_URL` | yes | — | e.g. `https://matrix.example.com` |
| `MATRIX_ACCESS_TOKEN` | yes | — | Bot access token (`syt_...`) |
| `MATRIX_USER_ID` | yes | — | e.g. `@matrixmind:example.com` |
| `MATRIX_PASSWORD` | no | — | Used once to bootstrap cross-signing if needed |
| `MATRIX_RECOVERY_KEY` | no | — | Unlocks Secret Storage; enables fully automatic device verification |
| `MATRIX_AUTO_VERIFY` | no | `true` | Run interactive SAS verification on startup when no recovery key is set |
| `MATRIX_AUTO_VERIFY_RESPONSE_FILE` | no | — | File containing `yes` or `no` as alternative to the HTTP confirm endpoint |
| `MATRIX_AUTO_VERIFY_STATUS_FILE` | no | `./workspaces/verify-status.json` | JSON status written during verification |
| `MATRIX_AUTO_VERIFY_TARGET_DEVICE_ID` | no | latest active device | Pin auto-verification to one specific Element device |
| `MATRIX_ALLOW_CROSS_SIGNING_RESET` | no | `false` | Wipe inaccessible SSSS and create fresh cross-signing keys |
| `ANTHROPIC_API_KEY` | yes | — | `sk-ant-...` |
| `KIE_AI_API_KEY` | no | — | Enables image and video generation via [kie.ai](https://kie.ai) |
| `CLAUDE_CODE_AVAILABLE` | no | `true` | Set to `false` to force the direct Anthropic API fallback |
| `CHROMADB_URL` | no | `http://chromadb:8000` | ChromaDB endpoint |
| `ALLOWED_HOMESERVERS` | no | — | Comma-separated list of Matrix homeservers (e.g. `example.com,other.org`). The bot only responds in rooms where at least one member comes from one of these servers. Leave empty to allow everyone. |
| `BOT_COMMAND_PREFIX` | no | `!` | Prefix that always triggers the bot (e.g. `!image ...`) |
| `REPLY_COOLDOWN_MS` | no | `5000` | Minimum ms between LLM replies per room |
| `MAX_REQUESTS_PER_ROOM_PER_MINUTE` | no | `10` | Rate limit per room |
| `PYTHON_EXECUTION_TIMEOUT_MS` | no | `30000` | Timeout for Claude Code subprocesses |
| `LOG_LEVEL` | no | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `WORKSPACES_DIR` | no | `./workspaces` | Host path where room workspaces are stored |

---

## Architecture

```text
src/
├── index.ts                Startup, wires all services together
├── config.ts               Zod-validated env config (single source of truth)
├── logger.ts               Pino structured logger
├── matrix/
│   ├── MatrixClient.ts     Wraps matrix-js-sdk, handles E2EE, emits timeline events
│   ├── EventRouter.ts      Parses m.room.message events, deduplicates
│   ├── MatrixActions.ts    send/edit/react/typing/upload/history operations
│   └── AutoSessionVerifier.ts
├── room/
│   ├── RoomManager.ts      Registry — one RoomContext per room, lazy init
│   ├── RoomContext.ts      Per-room state, orchestrates LLM + memory + media
│   └── WorkspaceManager.ts Filesystem operations within workspace boundaries
├── llm/
│   ├── LLMProvider.ts      Interface
│   ├── ClaudeCodeProvider.ts  Primary: Claude Code SDK with full tool access
│   ├── AnthropicProvider.ts   Fallback: direct Anthropic API
│   └── ContextAssembler.ts    Builds the prompt from SOUL, memory, history
├── memory/
│   ├── VectorStore.ts      ChromaDB client, forRoom() is the only entry point
│   └── MemoryManager.ts    Embeds messages, searches by semantic similarity
├── media/
│   └── KieAIClient.ts      Image and video generation via kie.ai API
├── filter/
│   └── ShouldReplyFilter.ts  3-stage reply decision (DMs) / strict addressing (groups)
├── cron/
│   ├── CronEngine.ts
│   └── CronStore.ts        SQLite-backed persistent cron jobs
├── skills/
│   └── SkillLoader.ts      Loads matching skill files from workspace
└── utils/
    ├── safePath.ts         Path traversal prevention
    ├── hash.ts
    ├── media.ts            MIME type helpers
    └── RateLimiter.ts
```

### LLM Provider

At startup the bot probes whether the Claude Code SDK is functional. If yes, every query runs with `cwd` set to the room's workspace — giving the model full tool access (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch) scoped to that directory. If unavailable, it falls back to a direct Anthropic API call.

### Reply Decision

**DMs** — three-stage pipeline:
1. Rules: reject own messages, emoji-only, known bot patterns; accept @mentions, command prefix.
2. Heuristics: question marks, question words, message length.
3. Claude Haiku classifier — only when stages 1 and 2 are inconclusive.

**Group rooms** — strict addressing only. The bot replies exclusively when:
- explicitly @mentioned or addressed by name
- message starts with the command prefix (`!`) or `/`
- message is a direct reply to one of the bot's own messages

Regardless of whether the bot replies, every incoming message is embedded into ChromaDB.

### Memory Architecture

```
Prompt budget (~2500 tokens):
  SOUL.md          500 tokens  personality and instructions, always included
  MEMORY.md        300 tokens  persistent key facts, always included
  Vector recall    600 tokens  top-4 semantically similar past messages
  Recent messages  800 tokens  last messages in the conversation
  Current message  300 tokens
  Current time     injected into the system block on every request
```

On first use after a restart the bot fetches the last 20 messages from the Matrix homeserver to restore conversation context.

### Room Isolation

- Workspace directory name = `SHA-256(roomId)` — never the raw room ID
- `safePath(base, relative)` throws on any path that escapes the workspace root
- `VectorStore.forRoom(hash)` returns a room-bound collection — no cross-room reads
- `CronStore` lives at `{workspace}/.cron/jobs.db`

### Persistence

| Data | Storage | Survives restart |
|---|---|---|
| SOUL.md, MEMORY.md, skills, files | Host volume (`./workspaces`) | yes |
| Vector embeddings | Docker volume (`chroma_data`) | yes |
| Cron jobs | SQLite in workspace | yes |
| E2EE crypto store | `./workspaces/indexeddb` | yes |
| Recent message buffer | RAM | no — reloaded from Matrix on first request |

---

## Media Generation

When `KIE_AI_API_KEY` is set, the bot can generate images and videos. Just ask naturally:

> "Generiere ein Bild von einem Sonnenuntergang über den Bergen"

The model responds with a `[IMAGE: ...]` or `[VIDEO: ...]` marker in its reply, which the bot intercepts, calls kie.ai, and sends the result directly into the Matrix room.

Explicit commands also work:

```
!image a cozy treehouse at golden hour, cinematic lighting
!video a paper airplane gliding through a rainy neon city
```

The bot can also send files from its workspace:

```
!send image files/generated/images/example.png
!send video files/generated/videos/clip.mp4
!send file files/report.pdf
```

Or via natural language if the file exists in the workspace:

> "Schick mir die Datei files/report.pdf"

---

## Skills

Drop a Markdown file into a room's workspace `skills/` directory. The bot loads matching skills based on keyword overlap with the incoming message.

```markdown
# weather
Query current weather for a city using web search and return a brief summary.
```

The bot can also create new skill files itself during a conversation.

---

## Cron Jobs

The bot can schedule cron jobs through conversation. Jobs are stored in SQLite and survive restarts.

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

## Development

```bash
npm install --legacy-peer-deps
npm run dev        # ts-node with .env
npm run typecheck  # tsc --noEmit
npm run test       # vitest
npm run build      # tsc → dist/
```

---

## Security

- `safePath()` prevents path traversal in all workspace file operations
- Room workspace names are SHA-256 hashes of the room ID, never raw IDs
- `VectorStore.forRoom()` has no cross-room read methods
- Container runs as `uid=1001` (non-root)
- All secrets via environment variables only
- Incoming filenames sanitized before storage
- Rate limiting per room (configurable)
- `ALLOWED_HOMESERVERS` restricts which Matrix servers can interact with the bot
- Claude Code `cwd` is scoped to the room workspace
