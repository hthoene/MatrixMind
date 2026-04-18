import { z } from "zod";

const envSchema = z.object({
  MATRIX_HOMESERVER_URL: z.string().url(),
  MATRIX_ACCESS_TOKEN: z.string().min(1),
  MATRIX_USER_ID: z.string().regex(/^@[^:]+:.+$/),
  MATRIX_PASSWORD: z.string().optional(),
  MATRIX_RECOVERY_KEY: z.string().optional(),
  MATRIX_AUTO_VERIFY: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  MATRIX_AUTO_VERIFY_RESPONSE_FILE: z.string().optional(),
  MATRIX_AUTO_VERIFY_STATUS_FILE: z.string().optional(),
  MATRIX_AUTO_VERIFY_TARGET_DEVICE_ID: z.string().optional(),
  MATRIX_ALLOW_CROSS_SIGNING_RESET: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  ANTHROPIC_API_KEY: z.string().min(1),
  KIE_AI_API_KEY: z.string().optional(),
  ALLOWED_HOMESERVERS: z
    .string()
    .optional()
    .transform((v) =>
      v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : []
    ),
  CLAUDE_CODE_AVAILABLE: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  CHROMADB_URL: z.string().url().default("http://chromadb:8000"),
  BOT_COMMAND_PREFIX: z.string().default("!"),
  REPLY_COOLDOWN_MS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default("5000"),
  MAX_REQUESTS_PER_ROOM_PER_MINUTE: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default("10"),
  PYTHON_EXECUTION_TIMEOUT_MS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().positive())
    .default("30000"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  WORKSPACES_DIR: z.string().default("./workspaces"),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${errors}`);
  }

  _config = result.data;
  return _config;
}
