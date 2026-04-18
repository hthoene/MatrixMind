#!/usr/bin/env node
/**
 * Generates a fresh Matrix access token via password login, updates .env, and
 * clears the local crypto state so the bot starts with a clean device on next
 * boot.  Run from the project root:
 *
 *   node scripts/relogin.mjs
 *
 * Requires MATRIX_PASSWORD to be set in .env (or the environment).
 */

import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");

// ---------------------------------------------------------------------------
// 1. Parse .env into a plain object
// ---------------------------------------------------------------------------
async function readEnv(envPath) {
  let raw;
  try {
    raw = await readFile(envPath, "utf8");
  } catch {
    throw new Error(`.env not found at ${envPath}`);
  }

  const env = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    // Strip inline comments, then unquote
    let value = trimmed.slice(idx + 1).trim().replace(/\s+#.*$/, "");
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return { raw, env };
}

// ---------------------------------------------------------------------------
// 2. Replace (or append) a key in the raw .env text
// ---------------------------------------------------------------------------
function setEnvKey(raw, key, value) {
  const regex = new RegExp(`^(${key}=).*$`, "m");
  if (regex.test(raw)) {
    return raw.replace(regex, `$1${value}`);
  }
  // Append at end
  return raw.trimEnd() + `\n${key}=${value}\n`;
}

// ---------------------------------------------------------------------------
// 3. Matrix password login
// ---------------------------------------------------------------------------
async function passwordLogin(homeserver, userId, password) {
  // Extract localpart from @user:server
  const localpart = userId.replace(/^@/, "").split(":")[0];

  const body = JSON.stringify({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: localpart },
    password,
    initial_device_display_name: "MatrixMind Bot",
  });

  const url = `${homeserver}/_matrix/client/v3/login`;
  console.log(`  POST ${url}`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `Login failed (${res.status}): ${JSON.stringify(json)}`
    );
  }
  return { accessToken: json.access_token, deviceId: json.device_id };
}

// ---------------------------------------------------------------------------
// 4. Delete old crypto state
// ---------------------------------------------------------------------------
async function clearCryptoState(workspacesDir) {
  const targets = [
    path.join(workspacesDir, ".device_id"),
    path.join(workspacesDir, "indexeddb"),
  ];

  for (const target of targets) {
    try {
      await rm(target, { recursive: true, force: true });
      console.log(`  Removed: ${target}`);
    } catch (err) {
      console.warn(`  Could not remove ${target}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== MatrixMind re-login ===\n");

  const { raw, env } = await readEnv(ENV_FILE);

  const homeserver = env.MATRIX_HOMESERVER_URL;
  const userId = env.MATRIX_USER_ID;
  const password = env.MATRIX_PASSWORD || process.env.MATRIX_PASSWORD;
  const workspacesDir = path.resolve(ROOT, env.WORKSPACES_DIR || "./workspaces");

  if (!homeserver) throw new Error("MATRIX_HOMESERVER_URL missing from .env");
  if (!userId) throw new Error("MATRIX_USER_ID missing from .env");
  if (!password) {
    throw new Error(
      "MATRIX_PASSWORD missing. Add it to .env or pass via environment:\n" +
        "  MATRIX_PASSWORD=secret node scripts/relogin.mjs"
    );
  }

  console.log(`Homeserver : ${homeserver}`);
  console.log(`User ID    : ${userId}`);
  console.log(`Workspaces : ${workspacesDir}\n`);

  // Step 1 — get new credentials
  console.log("Step 1: Logging in to get a fresh access token...");
  const { accessToken, deviceId } = await passwordLogin(homeserver, userId, password);
  console.log(`  New device ID   : ${deviceId}`);
  console.log(`  New access token: ${accessToken.slice(0, 12)}...\n`);

  // Step 2 — clear old crypto state
  console.log("Step 2: Clearing old crypto / device state...");
  await clearCryptoState(workspacesDir);
  console.log();

  // Step 3 — update .env
  console.log("Step 3: Updating .env...");
  let updated = setEnvKey(raw, "MATRIX_ACCESS_TOKEN", accessToken);
  await writeFile(ENV_FILE, updated, "utf8");
  console.log("  .env updated.\n");

  console.log("Done.  Restart the bot to apply the new token:");
  console.log("  docker compose down && docker compose up -d\n");
  console.log(
    "After restart, verify cross-signing with:\n" +
      "  docker compose exec bot node dist/verify.js\n"
  );
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
