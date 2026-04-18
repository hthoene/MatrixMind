import readline from "node:readline";
import { promises as fs } from "node:fs";
import {
  VerificationPhase,
  VerificationRequest,
  VerificationRequestEvent,
  Verifier,
  VerifierEvent,
  ShowSasCallbacks,
  EmojiMapping,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import { MatrixClient } from "./matrix/MatrixClient.js";
import { getConfig } from "./config.js";
import { getLogger } from "./logger.js";

process.env.MATRIX_AUTO_VERIFY ??= "false";

const log = getLogger("verify");

const SAS_METHOD = "m.sas.v1";

type SDKClient = ReturnType<MatrixClient["getSDKClient"]>;
type CryptoApi = NonNullable<ReturnType<SDKClient["getCrypto"]>>;
type OwnDevice = {
  device_id: string;
  display_name?: string;
  last_seen_ts?: number;
};

async function main(): Promise<void> {
  const config = getConfig();
  const rawTarget = process.argv[2];
  const targetUser =
    rawTarget && /^@[^:]+:.+$/.test(rawTarget) ? rawTarget : undefined;

  if (rawTarget && !targetUser) {
    console.error("Usage: verify [@user:server]");
    console.error(
      `Run without an argument to verify this bot session as ${config.MATRIX_USER_ID}.`
    );
    process.exit(1);
  }

  const client = new MatrixClient();
  await client.start();

  const sdk = client.getSDKClient();
  await waitForSync(sdk);
  log.info("Initial sync complete");

  const crypto = sdk.getCrypto();
  if (!crypto) throw new Error("Crypto not initialised");

  setSupportedVerificationMethods(crypto, [SAS_METHOD]);

  const isSelfVerification = !targetUser || targetUser === config.MATRIX_USER_ID;
  const request = isSelfVerification
    ? await requestOwnDeviceVerification(sdk, crypto, config.MATRIX_USER_ID)
    : await requestUserVerification(sdk, crypto, targetUser);

  const readyRequest = await waitForReady(request);
  log.info({ phase: readyRequest.phase }, "Request ready - starting SAS");

  const verifier = await getOrStartSasVerifier(readyRequest);
  const emoji = await showEmojis(verifier);
  printEmojis(emoji);

  const userOk = await promptYesNo(
    "Stimmen die Emojis mit denen in Element ueberein? [y/N] "
  );
  if (!userOk) {
    log.warn("User reported mismatch - cancelling");
    const sas = verifier.getShowSasCallbacks();
    if (sas) {
      sas.mismatch();
    } else {
      await readyRequest.cancel({ reason: "emoji mismatch" });
    }
    process.exit(2);
  }

  const sas = verifier.getShowSasCallbacks();
  if (!sas) throw new Error("SAS callbacks gone");
  await sas.confirm();
  log.info("Local confirmation sent - waiting for remote confirmation...");

  await waitForDone(readyRequest);
  log.info({ phase: readyRequest.phase }, "Verification complete");

  if (isSelfVerification) {
    await logOwnDeviceTrust(crypto, config.MATRIX_USER_ID, sdk.getDeviceId());
  }

  await client.stop();
  process.exit(0);
}

async function requestOwnDeviceVerification(
  sdk: SDKClient,
  crypto: CryptoApi,
  userId: string
): Promise<VerificationRequest> {
  const targetDevice = await pickOwnVerificationTargetDevice(sdk);
  log.info(
    {
      userId,
      targetDeviceId: targetDevice.device_id,
      targetDeviceName: targetDevice.display_name,
    },
    "Starting self-verification for the current bot session"
  );

  try {
    const incoming = new Promise<VerificationRequest>((resolve) => {
      const onRequest = (req: VerificationRequest): void => {
        if (
          req.otherUserId !== userId ||
          !req.isSelfVerification ||
          req.otherDeviceId !== targetDevice.device_id
        ) {
          return;
        }
        sdk.off(CryptoEvent.VerificationRequestReceived, onRequest);
        resolve(req);
      };
      sdk.on(CryptoEvent.VerificationRequestReceived, onRequest);
    });

    const request = await crypto.requestDeviceVerification(
      userId,
      targetDevice.device_id
    );
    log.info(
      {
        transactionId: request.transactionId,
        targetDeviceId: targetDevice.device_id,
        targetDeviceName: targetDevice.display_name,
      },
      "Verification request sent to your Element device - accept it there"
    );
    return Promise.race([waitForReady(request), incoming.then(waitForReady)]);
  } catch (err) {
    throw new Error(
      "Could not start self-verification. Cross-signing must already exist for this account. " +
        "Set it up in Element first, or provide MATRIX_PASSWORD so the bot can bootstrap it automatically.",
      { cause: err }
    );
  }
}

async function pickOwnVerificationTargetDevice(
  sdk: SDKClient
): Promise<OwnDevice> {
  const devices = await fetchOwnDevices();
  const currentDeviceId = sdk.getDeviceId();
  const candidates = devices
    .filter((device) => device.device_id !== currentDeviceId)
    .sort((a, b) => (b.last_seen_ts ?? 0) - (a.last_seen_ts ?? 0));

  if (candidates.length === 0) {
    throw new Error(
      "No other own Matrix device found to verify against. Log in with Element on another device first."
    );
  }

  return candidates[0]!;
}

async function fetchOwnDevices(): Promise<OwnDevice[]> {
  const config = getConfig();
  const response = await fetch(`${config.MATRIX_HOMESERVER_URL}/_matrix/client/v3/devices`, {
    headers: {
      Authorization: `Bearer ${config.MATRIX_ACCESS_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to load own devices: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { devices?: OwnDevice[] };
  return body.devices ?? [];
}

async function requestUserVerification(
  sdk: SDKClient,
  crypto: CryptoApi,
  targetUser: string
): Promise<VerificationRequest> {
  const roomId = findDMRoom(sdk, targetUser);
  if (!roomId) {
    throw new Error(
      `No joined room found with ${targetUser}. Make sure the bot shares a room with this user.`
    );
  }

  log.info({ roomId, targetUser }, "Starting verification in DM room");

  const incoming = new Promise<VerificationRequest>((resolve) => {
    const onRequest = (req: VerificationRequest): void => {
      if (req.otherUserId !== targetUser) return;
      sdk.off(CryptoEvent.VerificationRequestReceived, onRequest);
      resolve(req);
    };
    sdk.on(CryptoEvent.VerificationRequestReceived, onRequest);
  });

  const outgoing = await crypto.requestVerificationDM(targetUser, roomId);
  log.info(
    { transactionId: outgoing.transactionId },
    "Verification request sent - check Element and accept the prompt"
  );

  return Promise.race([waitForReady(outgoing), incoming.then(waitForReady)]);
}

function waitForSync(sdk: SDKClient): Promise<void> {
  return new Promise((resolve) => {
    if (sdk.isInitialSyncComplete()) return resolve();
    const onSync = (state: string): void => {
      if (state === "PREPARED" || state === "SYNCING") {
        sdk.removeListener("sync" as never, onSync as never);
        resolve();
      }
    };
    sdk.on("sync" as never, onSync as never);
  });
}

function findDMRoom(sdk: SDKClient, targetUser: string): string | undefined {
  for (const room of sdk.getRooms()) {
    const members = room.getJoinedMembers().map((member) => member.userId);
    if (members.includes(targetUser) && members.length <= 2) return room.roomId;
  }

  for (const room of sdk.getRooms()) {
    if (room.getJoinedMembers().some((member) => member.userId === targetUser)) {
      return room.roomId;
    }
  }

  return undefined;
}

async function waitForReady(
  request: VerificationRequest
): Promise<VerificationRequest> {
  if (
    request.phase === VerificationPhase.Ready ||
    request.phase === VerificationPhase.Started
  ) {
    return request;
  }

  if (!request.initiatedByMe && request.phase === VerificationPhase.Requested) {
    await request.accept();
  }

  await new Promise<void>((resolve, reject) => {
    const onChange = (): void => {
      if (
        request.phase === VerificationPhase.Ready ||
        request.phase === VerificationPhase.Started
      ) {
        finish(resolve);
      } else if (
        request.phase === VerificationPhase.Cancelled ||
        request.phase === VerificationPhase.Done
      ) {
        finish(() =>
          reject(new Error(`Verification ended in phase ${request.phase}`))
        );
      }
    };

    const poll = setInterval(onChange, 500);

    const finish = (fn: () => void): void => {
      clearInterval(poll);
      request.off(VerificationRequestEvent.Change, onChange);
      fn();
    };

    request.on(VerificationRequestEvent.Change, onChange);
    onChange();
  });

  return request;
}

async function getOrStartSasVerifier(
  request: VerificationRequest
): Promise<Verifier> {
  if (request.phase === VerificationPhase.Started) {
    if (request.chosenMethod && request.chosenMethod !== SAS_METHOD) {
      throw new Error(
        `Unsupported verification method ${request.chosenMethod}; this CLI only supports ${SAS_METHOD}`
      );
    }

    if (request.verifier) return request.verifier;
  }

  return request.startVerification(SAS_METHOD);
}

function showEmojis(verifier: Verifier): Promise<EmojiMapping[]> {
  return new Promise((resolve, reject) => {
    const existing = verifier.getShowSasCallbacks();
    if (existing?.sas.emoji) return resolve(existing.sas.emoji);

    verifier.on(VerifierEvent.ShowSas, (cb: ShowSasCallbacks) => {
      if (cb.sas.emoji) resolve(cb.sas.emoji);
      else reject(new Error("Verifier did not produce emoji SAS"));
    });
    verifier.on(VerifierEvent.Cancel, (event) => {
      reject(event instanceof Error ? event : new Error("Verification cancelled"));
    });
    verifier.verify().catch(reject);
  });
}

async function logOwnDeviceTrust(
  crypto: CryptoApi,
  userId: string,
  deviceId: string | null | undefined
): Promise<void> {
  if (!deviceId) {
    log.warn("SDK client has no device ID - cannot print verification status");
    return;
  }

  const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
  if (!status) {
    log.warn({ userId, deviceId }, "Could not load verification status for own device");
    return;
  }

  log.info(
    {
      userId,
      deviceId,
      verified: status.isVerified(),
      crossSigningVerified: status.crossSigningVerified,
      localVerified: status.localVerified,
      signedByOwner: status.signedByOwner,
    },
    "Own device verification status after SAS"
  );
}

function setSupportedVerificationMethods(
  crypto: CryptoApi,
  methods: string[]
): void {
  (
    crypto as { setSupportedVerificationMethods?: (value: string[] | undefined) => void }
  ).setSupportedVerificationMethods?.(methods);
}

function printEmojis(emoji: EmojiMapping[]): void {
  console.log("\n======================================================");
  console.log(" SAS-EMOJIS (mit Element vergleichen!):");
  console.log("======================================================");
  const line = emoji.map(([symbol]) => symbol).join("   ");
  const names = emoji.map(([, name]) => name).join(", ");
  console.log(`  ${line}`);
  console.log(`  (${names})`);
  console.log("======================================================\n");
}

function waitForDone(request: VerificationRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const onChange = (): void => {
      if (request.phase === VerificationPhase.Done) {
        finish(resolve);
      } else if (request.phase === VerificationPhase.Cancelled) {
        finish(() => reject(new Error("Verification cancelled by remote")));
      }
    };

    const poll = setInterval(onChange, 500);

    const finish = (fn: () => void): void => {
      clearInterval(poll);
      request.off(VerificationRequestEvent.Change, onChange);
      fn();
    };

    request.on(VerificationRequestEvent.Change, onChange);
    onChange();
  });
}

function promptYesNo(question: string): Promise<boolean> {
  const responseFile = process.env.VERIFY_RESPONSE_FILE;
  if (responseFile) {
    return waitForYesNoFile(responseFile, question);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function waitForYesNoFile(
  responseFile: string,
  question: string
): Promise<boolean> {
  console.log(question);
  console.log(`Waiting for response file: ${responseFile}`);

  while (true) {
    try {
      const answer = (await fs.readFile(responseFile, "utf8")).trim();
      if (/^y(es)?$/i.test(answer)) return true;
      if (/^n(o)?$/i.test(answer)) return false;
    } catch (err) {
      if (!isFileNotFoundError(err)) throw err;
    }

    await sleep(1000);
  }
}

function isFileNotFoundError(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && err.code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

getConfig();

main().catch((err) => {
  log.error({ err }, "Verification failed");
  process.exit(1);
});
