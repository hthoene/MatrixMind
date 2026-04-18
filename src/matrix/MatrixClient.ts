import sdk, {
  MatrixClient as SDKClient,
  MatrixEvent,
  MatrixEventEvent,
  Room,
  RoomMemberEvent,
} from "matrix-js-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";

const log = getLogger("MatrixClient");

export type MatrixEventHandler = (event: MatrixEvent, room: Room | undefined) => void;

export class MatrixClient {
  private client!: SDKClient;
  private handlers: MatrixEventHandler[] = [];
  private initialized = false;

  async start(): Promise<void> {
    if (!this.initialized) {
      await this.init();
      this.initialized = true;
    }

    this.client.on(sdk.RoomEvent.Timeline, (event, room) => {
      this.dispatchEvent(event, room ?? undefined);
    });

    this.client.on(RoomMemberEvent.Membership, (_event, member) => {
      if (
        member.membership === "invite" &&
        member.userId === this.getUserId()
      ) {
        log.info({ roomId: member.roomId }, "Received invite – auto-joining");
        this.client.joinRoom(member.roomId).catch((err) => {
          log.error({ err, roomId: member.roomId }, "Failed to auto-join room");
        });
      }
    });

    await this.client.startClient({ initialSyncLimit: 0 });
    log.info(
      { userId: this.getUserId(), deviceId: this.client.getDeviceId() },
      "Matrix client started (E2EE enabled)"
    );
  }

  private dispatchEvent(event: MatrixEvent, room: Room | undefined): void {
    // Encrypted events arrive with type "m.room.encrypted". The SDK decrypts
    // them asynchronously and fires MatrixEventEvent.Decrypted when done.
    // We dispatch only after decryption so downstream handlers see plaintext.
    if (event.isEncrypted() && event.getType() === "m.room.encrypted") {
      event.once(MatrixEventEvent.Decrypted, () => {
        if (event.isDecryptionFailure()) {
          log.warn(
            { eventId: event.getId(), roomId: event.getRoomId() },
            "Decryption failed – skipping event"
          );
          return;
        }
        this.runHandlers(event, room);
      });
      return;
    }
    this.runHandlers(event, room);
  }

  private runHandlers(event: MatrixEvent, room: Room | undefined): void {
    for (const handler of this.handlers) {
      try {
        handler(event, room);
      } catch (err) {
        log.error({ err }, "Event handler threw");
      }
    }
  }

  private async init(): Promise<void> {
    const config = getConfig();

    // Install a disk-backed IndexedDB polyfill BEFORE matrix-js-sdk needs it.
    // node-indexeddb persists to a LevelDB directory next to process.cwd();
    // we temporarily chdir into WORKSPACES_DIR so the DB lands inside the
    // mounted volume and survives restarts.
    await installPersistentIndexedDB(config.WORKSPACES_DIR);

    const deviceId = await this.loadOrCreateDeviceId();

    this.client = sdk.createClient({
      baseUrl: config.MATRIX_HOMESERVER_URL,
      accessToken: config.MATRIX_ACCESS_TOKEN,
      userId: config.MATRIX_USER_ID,
      deviceId,
    });

    await this.client.initRustCrypto({ useIndexedDB: true });
    this.client.getCrypto()?.setTrustCrossSignedDevices(true);
    log.info({ deviceId }, "Rust crypto initialized (persistent store)");

    await this.ensureCrossSigning();
  }

  private async ensureCrossSigning(): Promise<void> {
    const crypto = this.client.getCrypto();
    if (!crypto) return;

    if (await crypto.isCrossSigningReady()) {
      log.info("Cross-signing already set up");
      return;
    }

    const config = getConfig();
    if (!config.MATRIX_PASSWORD) {
      log.warn(
        "Cross-signing NOT ready and MATRIX_PASSWORD is not set – " +
          "users must verify each bot device individually. " +
          "Set MATRIX_PASSWORD once to auto-bootstrap cross-signing."
      );
      return;
    }

    const uiaAuth = async (
      makeRequest: (authData: {
        type: string;
        identifier: { type: string; user: string };
        password: string;
      }) => Promise<unknown>
    ): Promise<void> => {
      await makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: config.MATRIX_USER_ID },
        password: config.MATRIX_PASSWORD!,
      });
    };

    log.info("Bootstrapping cross-signing (one-time setup)");
    try {
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: uiaAuth,
      });
      log.info("Cross-signing bootstrap complete");
      return;
    } catch (err) {
      log.warn(
        { err },
        "Initial cross-signing bootstrap failed – clearing stale SSSS and retrying"
      );
    }

    // SSSS on the server is inaccessible (no recovery key). Wipe the
    // server-side SSSS config so the library treats it as "not set up" and
    // skips the export step during resetCrossSigning.
    await this.clearServerSideSecretStorage();

    try {
      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: uiaAuth,
      });
      log.info("Cross-signing bootstrap complete (fresh keys)");
    } catch (retryErr) {
      log.error(
        { err: retryErr },
        "Cross-signing bootstrap failed – continuing without it"
      );
    }
  }

  private async clearServerSideSecretStorage(): Promise<void> {
    const config = getConfig();
    const base = `${config.MATRIX_HOMESERVER_URL}/_matrix/client/v3/user/${encodeURIComponent(
      config.MATRIX_USER_ID
    )}/account_data`;
    const headers = {
      Authorization: `Bearer ${config.MATRIX_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    };

    // Find existing SSSS key IDs by reading the default key pointer.
    const keyIds = new Set<string>();
    try {
      const res = await fetch(`${base}/m.secret_storage.default_key`, {
        headers,
      });
      if (res.ok) {
        const body = (await res.json()) as { key?: string };
        if (body.key) keyIds.add(body.key);
      }
    } catch {
      // ignore; nothing to clean
    }

    // Types to wipe. Account data can't be deleted, so we overwrite with `{}`.
    const types = [
      "m.secret_storage.default_key",
      "m.cross_signing.master",
      "m.cross_signing.self_signing",
      "m.cross_signing.user_signing",
      "m.megolm_backup.v1",
      ...[...keyIds].map((id) => `m.secret_storage.key.${id}`),
    ];

    for (const type of types) {
      try {
        await fetch(`${base}/${encodeURIComponent(type)}`, {
          method: "PUT",
          headers,
          body: "{}",
        });
      } catch (err) {
        log.warn({ err, type }, "Failed to clear account data entry");
      }
    }
    log.info({ cleared: types.length }, "Cleared server-side SSSS config");
  }

  private async loadOrCreateDeviceId(): Promise<string> {
    const config = getConfig();
    const filePath = path.resolve(config.WORKSPACES_DIR, ".device_id");
    try {
      const existing = (await fs.readFile(filePath, "utf8")).trim();
      if (existing) return existing;
    } catch {
      // file does not exist yet
    }
    // Access tokens are bound to the device that created them.
    const res = await fetch(
      `${config.MATRIX_HOMESERVER_URL}/_matrix/client/v3/account/whoami`,
      { headers: { Authorization: `Bearer ${config.MATRIX_ACCESS_TOKEN}` } }
    );
    if (!res.ok) {
      throw new Error(`whoami failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { device_id?: string };
    const deviceId = body.device_id;
    if (!deviceId) {
      throw new Error("whoami response did not contain device_id");
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, deviceId, "utf8");
    log.info({ deviceId }, "Resolved device id from homeserver");
    return deviceId;
  }

  onTimelineEvent(handler: MatrixEventHandler): void {
    this.handlers.push(handler);
  }

  getSDKClient(): SDKClient {
    return this.client;
  }

  getUserId(): string {
    const config = getConfig();
    return config.MATRIX_USER_ID;
  }

  async stop(): Promise<void> {
    this.client.stopClient();
    log.info("Matrix client stopped");
  }
}

let indexedDBInstalled = false;

async function installPersistentIndexedDB(workspacesDir: string): Promise<void> {
  if (indexedDBInstalled) return;
  const absWorkspaces = path.resolve(workspacesDir);
  await fs.mkdir(absWorkspaces, { recursive: true });

  // node-indexeddb resolves its LevelDB path via process.cwd() at module-load
  // time (path.resolve(process.cwd(), "indexeddb")). We briefly chdir into the
  // workspaces volume so the first import binds to absWorkspaces/indexeddb.
  const originalCwd = process.cwd();
  process.chdir(absWorkspaces);
  try {
    const { default: dbManager } = (await import(
      "node-indexeddb/dbManager"
    )) as { default: { loadCache(): Promise<void> } };
    await dbManager.loadCache();
    await import("node-indexeddb/auto");
  } finally {
    process.chdir(originalCwd);
  }

  indexedDBInstalled = true;
  log.info(
    { path: path.join(absWorkspaces, "indexeddb") },
    "Persistent IndexedDB initialised"
  );
}
