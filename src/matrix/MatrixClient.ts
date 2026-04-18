import sdk, {
  MatrixClient as SDKClient,
  MatrixEvent,
  MatrixEventEvent,
  Room,
  RoomMemberEvent,
} from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";
import {
  getDefaultAutoVerificationStatusFile,
  maybeAutoVerifyCurrentSession,
} from "./AutoSessionVerifier.js";

const log = getLogger("MatrixClient");

export type MatrixEventHandler = (
  event: MatrixEvent,
  room: Room | undefined
) => void;

export class MatrixClient {
  private client!: SDKClient;
  private handlers: MatrixEventHandler[] = [];
  private initialized = false;
  private autoVerificationStarted = false;

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
        log.info({ roomId: member.roomId }, "Received invite - auto-joining");
        this.client
          .joinRoom(member.roomId)
          .then(() => {
            log.info({ roomId: member.roomId }, "Joined room successfully");
          })
          .catch((err) => {
            log.error({ err, roomId: member.roomId }, "Failed to auto-join room");
          });
      }
    });

    this.client.on(sdk.ClientEvent.UndecryptableToDeviceEvent, (event) => {
      const wireContent = event.getWireContent() as {
        algorithm?: string;
        sender_key?: string;
      };

      log.warn(
        {
          sender: event.getSender(),
          type: event.getType(),
          algorithm: wireContent.algorithm,
          senderKey: wireContent.sender_key,
        },
        "Received undecryptable to-device event - room keys may not reach this bot device"
      );
    });

    await this.client.startClient({ initialSyncLimit: 0 });
    log.info(
      { userId: this.getUserId(), deviceId: this.client.getDeviceId() },
      "Matrix client started (E2EE enabled)"
    );

    this.startAutoVerification();
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
            "Decryption failed - skipping event"
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
    const cryptoCallbacks = this.createCryptoCallbacks(
      config.MATRIX_RECOVERY_KEY
    );

    this.client = sdk.createClient({
      baseUrl: config.MATRIX_HOMESERVER_URL,
      accessToken: config.MATRIX_ACCESS_TOKEN,
      userId: config.MATRIX_USER_ID,
      deviceId,
      cryptoCallbacks,
    });

    await this.client.initRustCrypto({ useIndexedDB: true });
    this.client.getCrypto()?.setTrustCrossSignedDevices(true);
    log.info({ deviceId }, "Rust crypto initialized (persistent store)");

    await this.ensureCrossSigning();
    await this.ensureTrustedKeyBackup();
  }

  private async ensureCrossSigning(): Promise<void> {
    const crypto = this.client.getCrypto();
    if (!crypto) return;

    if (await crypto.isCrossSigningReady()) {
      log.info("Cross-signing already set up");
      return;
    }

    const config = getConfig();
    const hasRecoveryKey = Boolean(config.MATRIX_RECOVERY_KEY?.trim());
    const hasPassword = Boolean(config.MATRIX_PASSWORD);

    if (hasRecoveryKey) {
      log.info(
        "Cross-signing is not ready yet - trying to unlock existing cross-signing keys from secret storage"
      );

      try {
        await crypto.bootstrapCrossSigning({
          authUploadDeviceSigningKeys: hasPassword
            ? this.createUiaAuth()
            : undefined,
        });
        await this.logCurrentDeviceTrust(
          "Cross-signing bootstrap via recovery key complete"
        );
        return;
      } catch (err) {
        log.warn(
          { err },
          "Unlocking cross-signing via MATRIX_RECOVERY_KEY failed - falling back to the remaining bootstrap options"
        );
      }
    }

    if (!hasPassword) {
      log.warn(
        "Cross-signing NOT ready and MATRIX_PASSWORD is not set - " +
          "MatrixMind cannot upload or create cross-signing keys automatically. " +
          "Provide MATRIX_RECOVERY_KEY to unlock existing keys or MATRIX_PASSWORD for one-time bootstrap."
      );
      return;
    }

    const uiaAuth = this.createUiaAuth();

    log.info("Bootstrapping cross-signing (one-time setup)");
    try {
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: uiaAuth,
      });
      await this.logCurrentDeviceTrust("Cross-signing bootstrap complete");
      return;
    } catch (err) {
      log.warn(
        { err },
        "Initial cross-signing bootstrap failed - clearing stale SSSS and retrying"
      );
    }

    if (!config.MATRIX_ALLOW_CROSS_SIGNING_RESET) {
      log.error(
        "Cross-signing bootstrap failed and automatic reset is disabled. " +
          "To avoid destroying existing trust, MatrixMind will continue without resetting SSSS or cross-signing. " +
          "If you really want a full reset, set MATRIX_ALLOW_CROSS_SIGNING_RESET=true explicitly."
      );
      return;
    }

    // SSSS on the server is inaccessible (no recovery key). Wipe the
    // server-side SSSS config so the library treats it as "not set up" and
    // skips the export step during resetCrossSigning.
    log.warn(
      "Automatic cross-signing reset is explicitly enabled - clearing server-side SSSS and creating fresh cross-signing keys"
    );
    await this.clearServerSideSecretStorage();

    try {
      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: uiaAuth,
      });
      await this.logCurrentDeviceTrust(
        "Cross-signing bootstrap complete (fresh keys)"
      );
    } catch (retryErr) {
      log.error(
        { err: retryErr },
        "Cross-signing bootstrap failed - continuing without it"
      );
    }
  }

  private createUiaAuth(): (
    makeRequest: (authData: {
      type: string;
      identifier: { type: string; user: string };
      password: string;
    }) => Promise<unknown>
  ) => Promise<void> {
    const config = getConfig();

    return async (makeRequest) => {
      if (!config.MATRIX_PASSWORD) {
        throw new Error(
          "MATRIX_PASSWORD is required for interactive authentication during cross-signing bootstrap"
        );
      }

      await makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: config.MATRIX_USER_ID },
        password: config.MATRIX_PASSWORD,
      });
    };
  }

  private createCryptoCallbacks(
    recoveryKey: string | undefined
  ): Parameters<typeof sdk.createClient>[0]["cryptoCallbacks"] | undefined {
    const trimmedRecoveryKey = recoveryKey?.trim();
    if (!trimmedRecoveryKey) return undefined;

    let decodedRecoveryKey: Uint8Array | null = null;

    return {
      getSecretStorageKey: async ({ keys }, name) => {
        if (!decodedRecoveryKey) {
          decodedRecoveryKey = decodeRecoveryKey(trimmedRecoveryKey);
        }
        const recoveryKeyBytes = decodedRecoveryKey;

        for (const [keyId, keyInfo] of Object.entries(keys)) {
          const matches = await this.client.checkSecretStorageKey(
            recoveryKeyBytes,
            keyInfo
          );
          if (matches) {
            log.info(
              { keyId, secretName: name },
              "Unlocked secret storage with MATRIX_RECOVERY_KEY"
            );
            return [keyId, recoveryKeyBytes];
          }
        }

        log.warn(
          { requestedKeyIds: Object.keys(keys), secretName: name },
          "MATRIX_RECOVERY_KEY did not match any requested secret storage key"
        );
        return null;
      },
    };
  }

  private async logCurrentDeviceTrust(message: string): Promise<void> {
    const crypto = this.client.getCrypto();
    const deviceId = this.client.getDeviceId();
    if (!crypto || !deviceId) {
      log.info(message);
      return;
    }

    const config = getConfig();
    const status = await crypto.getDeviceVerificationStatus(
      config.MATRIX_USER_ID,
      deviceId
    );

    log.info(
      {
        deviceId,
        verified: status?.isVerified(),
        crossSigningVerified: status?.crossSigningVerified,
        localVerified: status?.localVerified,
        signedByOwner: status?.signedByOwner,
      },
      message
    );
  }

  private async ensureTrustedKeyBackup(): Promise<void> {
    const config = getConfig();
    if (!config.MATRIX_RECOVERY_KEY?.trim()) return;

    const crypto = this.client.getCrypto();
    if (!crypto?.checkKeyBackupAndEnable) return;

    try {
      const backupCheck = await crypto.checkKeyBackupAndEnable();
      if (!backupCheck) {
        log.info(
          "No server-side key backup was enabled after cross-signing setup"
        );
        return;
      }

      log.info(
        {
          backupVersion: backupCheck.backupInfo?.version,
          backupTrusted: backupCheck.trustInfo?.trusted,
          backupMatchesDecryptionKey:
            backupCheck.trustInfo?.matchesDecryptionKey,
        },
        "Re-checked server-side key backup after cross-signing setup"
      );
    } catch (err) {
      log.warn(
        { err },
        "Failed to re-check trusted key backup after cross-signing setup"
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

  private startAutoVerification(): void {
    if (this.autoVerificationStarted) return;
    this.autoVerificationStarted = true;

    const config = getConfig();
    if (config.MATRIX_RECOVERY_KEY?.trim()) {
      log.info(
        "Skipping interactive auto verification because MATRIX_RECOVERY_KEY is configured"
      );
      return;
    }

    if (!config.MATRIX_AUTO_VERIFY) {
      log.info("Automatic session verification disabled");
      return;
    }

    const responseFile = config.MATRIX_AUTO_VERIFY_RESPONSE_FILE;
    const statusFile =
      config.MATRIX_AUTO_VERIFY_STATUS_FILE ??
      getDefaultAutoVerificationStatusFile();

    void maybeAutoVerifyCurrentSession(this.client, {
      userId: config.MATRIX_USER_ID,
      responseFile,
      statusFile,
      targetDeviceId: config.MATRIX_AUTO_VERIFY_TARGET_DEVICE_ID,
    }).catch((err) => {
      log.error({ err }, "Automatic session verification crashed");
    });
  }
}

let indexedDBInstalled = false;

type IndexedDbManager = {
  loadCache(): Promise<void>;
  db?: {
    status?: string;
    open(): Promise<void>;
  };
};

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
    const importedDbManager = (await import(
      "node-indexeddb/dbManager"
    )) as unknown as { default: IndexedDbManager };
    const dbManager = importedDbManager.default;

    try {
      if (dbManager.db?.status !== "open") {
        await dbManager.db?.open();
      }
      await dbManager.loadCache();
    } catch (err) {
      throw explainIndexedDbInitError(
        err,
        path.join(absWorkspaces, "indexeddb")
      );
    }

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

function explainIndexedDbInitError(err: unknown, dbPath: string): Error {
  const code = getErrorCode(err);
  if (code === "LEVEL_LOCKED") {
    return new Error(
      `Persistent IndexedDB is locked at ${dbPath}. Another MatrixMind process is likely using the same crypto store. Stop that process before starting this one.`,
      { cause: err }
    );
  }

  if (code === "LEVEL_DATABASE_NOT_OPEN") {
    return new Error(
      `Persistent IndexedDB at ${dbPath} could not be opened before loading the crypto store.`,
      { cause: err }
    );
  }

  return err instanceof Error ? err : new Error(String(err));
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;

  const maybeCode =
    "code" in err && typeof err.code === "string" ? err.code : undefined;
  if (maybeCode) return maybeCode;

  const cause = "cause" in err ? err.cause : undefined;
  return getErrorCode(cause);
}
