import readline from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { MatrixClient as SDKClient } from "matrix-js-sdk";
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
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";

const log = getLogger("AutoVerify");
const SAS_METHOD = "m.sas.v1";

type CryptoApi = NonNullable<ReturnType<SDKClient["getCrypto"]>>;

type OwnDevice = {
  device_id: string;
  display_name?: string;
  last_seen_ts?: number;
};

type VerificationStatusFile = {
  state:
    | "already_verified"
    | "awaiting_confirmation"
    | "verified"
    | "cancelled"
    | "failed";
  updatedAt: string;
  currentDeviceId?: string | null;
  targetDeviceId?: string;
  targetDeviceName?: string;
  transactionId?: string;
  responseFile?: string;
  emojis?: string[];
  emojiNames?: string[];
  reason?: string;
};

type PendingHttpConfirmation = {
  token: string;
  question: string;
  createdAt: string;
  resolve: (value: boolean) => void;
};

type AutoVerificationSnapshot = {
  state:
    | "idle"
    | "awaiting_confirmation"
    | "verified"
    | "cancelled"
    | "failed"
    | "already_verified";
  currentDeviceId?: string | null;
  targetDeviceId?: string;
  targetDeviceName?: string;
  transactionId?: string;
  emojis?: string[];
  emojiNames?: string[];
  responseFile?: string;
  confirmationEndpoint?: string;
  confirmCommand?: string;
  rejectCommand?: string;
  updatedAt: string;
  reason?: string;
};

let pendingHttpConfirmation: PendingHttpConfirmation | null = null;
let autoVerificationSnapshot: AutoVerificationSnapshot = {
  state: "idle",
  updatedAt: new Date().toISOString(),
};

export type AutoSessionVerificationOptions = {
  userId: string;
  responseFile?: string;
  statusFile?: string;
  targetDeviceId?: string;
};

export async function maybeAutoVerifyCurrentSession(
  sdk: SDKClient,
  options: AutoSessionVerificationOptions
): Promise<void> {
  await waitForInitialSync(sdk);

  const crypto = sdk.getCrypto();
  if (!crypto) {
    log.warn("Crypto not initialised - skipping auto verification");
    return;
  }

  const currentDeviceId = sdk.getDeviceId();
  if (!currentDeviceId) {
    log.warn("SDK client has no device ID - skipping auto verification");
    return;
  }

  const status = await crypto.getDeviceVerificationStatus(
    options.userId,
    currentDeviceId
  );
  const previousStatus = await readStatusFile(options.statusFile);
  const recoveryKeyConfigured = Boolean(getConfig().MATRIX_RECOVERY_KEY?.trim());
  if (
    previousStatus?.state === "verified" &&
    previousStatus.currentDeviceId === currentDeviceId
  ) {
    updateSnapshot({
      state: "already_verified",
      updatedAt: new Date().toISOString(),
      currentDeviceId,
    });
    log.info(
      { deviceId: currentDeviceId },
      "Current bot session was already confirmed by a previous interactive verification"
    );
    return;
  }

  if (
    recoveryKeyConfigured &&
    status?.signedByOwner &&
    (status.crossSigningVerified || status.isVerified())
  ) {
    updateSnapshot({
      state: "already_verified",
      updatedAt: new Date().toISOString(),
      currentDeviceId,
    });
    await writeStatusFile(options.statusFile, {
      state: "verified",
      updatedAt: new Date().toISOString(),
      currentDeviceId,
      reason: "Verified automatically via MATRIX_RECOVERY_KEY and cross-signing",
    });
    log.info(
      { deviceId: currentDeviceId },
      "Current bot session is already cross-signed via MATRIX_RECOVERY_KEY - skipping SAS verification"
    );
    return;
  }

  if (status?.isVerified()) {
    log.warn(
      { deviceId: currentDeviceId },
      "Current bot session looks verified from the local SDK view, but no prior interactive verification marker was found - continuing with automatic verification"
    );
  }

  try {
    await verifyCurrentSession(sdk, crypto, options);
  } catch (err) {
    log.error({ err }, "Automatic session verification failed");
    updateSnapshot({
      state: "failed",
      updatedAt: new Date().toISOString(),
      currentDeviceId,
      reason: err instanceof Error ? err.message : String(err),
    });
    await writeStatusFile(options.statusFile, {
      state: "failed",
      updatedAt: new Date().toISOString(),
      currentDeviceId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getDefaultAutoVerificationResponseFile(): string | undefined {
  const config = getConfig();
  return (
    config.MATRIX_AUTO_VERIFY_RESPONSE_FILE ??
    path.resolve(config.WORKSPACES_DIR, "verify-response.txt")
  );
}

export function getDefaultAutoVerificationStatusFile(): string {
  const config = getConfig();
  return (
    config.MATRIX_AUTO_VERIFY_STATUS_FILE ??
    path.resolve(config.WORKSPACES_DIR, "verify-status.json")
  );
}

async function verifyCurrentSession(
  sdk: SDKClient,
  crypto: CryptoApi,
  options: AutoSessionVerificationOptions
): Promise<void> {
  setSupportedVerificationMethods(crypto, [SAS_METHOD]);

  const currentDeviceId = sdk.getDeviceId();
  const targetDevice = await pickOwnVerificationTargetDevice(
    sdk,
    options.targetDeviceId
  );

  log.info(
    {
      currentDeviceId,
      targetDeviceId: targetDevice.device_id,
      targetDeviceName: targetDevice.display_name,
    },
    "Starting automatic session verification"
  );

  const request = await requestOwnDeviceVerification(
    sdk,
    crypto,
    options.userId,
    targetDevice
  );

  const readyRequest = await waitForReady(request);
  log.info(
    { phase: readyRequest.phase, transactionId: readyRequest.transactionId },
    "Auto verification request ready - starting SAS"
  );

  const verifier = await getOrStartSasVerifier(readyRequest);
  const emoji = await showEmojis(verifier);
  printEmojis(emoji);

  await writeStatusFile(options.statusFile, {
    state: "awaiting_confirmation",
    updatedAt: new Date().toISOString(),
    currentDeviceId,
    targetDeviceId: targetDevice.device_id,
    targetDeviceName: targetDevice.display_name,
    transactionId: readyRequest.transactionId,
    responseFile: options.responseFile,
    emojis: emoji.map(([symbol]) => symbol),
    emojiNames: emoji.map(([, name]) => name),
  });
  updateSnapshot({
    state: "awaiting_confirmation",
    updatedAt: new Date().toISOString(),
    currentDeviceId,
    targetDeviceId: targetDevice.device_id,
    targetDeviceName: targetDevice.display_name,
    transactionId: readyRequest.transactionId,
    responseFile: options.responseFile,
    emojis: emoji.map(([symbol]) => symbol),
    emojiNames: emoji.map(([, name]) => name),
  });

  const userOk = await promptYesNo(
    "Stimmen die Emojis mit denen in Element ueberein? [y/N] ",
    options.responseFile
  );
  if (!userOk) {
    const sas = verifier.getShowSasCallbacks();
    if (sas) {
      sas.mismatch();
    } else {
      await readyRequest.cancel({ reason: "emoji mismatch" });
    }

    await writeStatusFile(options.statusFile, {
      state: "cancelled",
      updatedAt: new Date().toISOString(),
      currentDeviceId,
      targetDeviceId: targetDevice.device_id,
      targetDeviceName: targetDevice.display_name,
      transactionId: readyRequest.transactionId,
      reason: "User reported emoji mismatch",
    });
    updateSnapshot({
      state: "cancelled",
      updatedAt: new Date().toISOString(),
      currentDeviceId,
      targetDeviceId: targetDevice.device_id,
      targetDeviceName: targetDevice.display_name,
      transactionId: readyRequest.transactionId,
      reason: "User reported emoji mismatch",
    });

    throw new Error("Auto verification cancelled because the emoji SAS did not match");
  }

  const sas = verifier.getShowSasCallbacks();
  if (!sas) throw new Error("SAS callbacks gone");
  await sas.confirm();
  log.info("Local confirmation sent - waiting for remote confirmation...");

  await waitForDone(readyRequest);
  await logOwnDeviceTrust(crypto, options.userId, currentDeviceId);

  await writeStatusFile(options.statusFile, {
    state: "verified",
    updatedAt: new Date().toISOString(),
    currentDeviceId,
    targetDeviceId: targetDevice.device_id,
    targetDeviceName: targetDevice.display_name,
    transactionId: readyRequest.transactionId,
  });
  updateSnapshot({
    state: "verified",
    updatedAt: new Date().toISOString(),
    currentDeviceId,
    targetDeviceId: targetDevice.device_id,
    targetDeviceName: targetDevice.display_name,
    transactionId: readyRequest.transactionId,
  });

  log.info({ deviceId: currentDeviceId }, "Automatic session verification complete");
}

async function requestOwnDeviceVerification(
  sdk: SDKClient,
  crypto: CryptoApi,
  userId: string,
  targetDevice: OwnDevice
): Promise<VerificationRequest> {
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
    "Verification request sent to the selected Element device"
  );

  return Promise.race([waitForReady(request), incoming.then(waitForReady)]);
}

async function pickOwnVerificationTargetDevice(
  sdk: SDKClient,
  preferredDeviceId?: string
): Promise<OwnDevice> {
  const devices = await fetchOwnDevices();
  const currentDeviceId = sdk.getDeviceId();
  const candidates = devices.filter(
    (device) =>
      device.device_id !== currentDeviceId && !isDehydratedDevice(device)
  );

  if (preferredDeviceId) {
    const preferred = candidates.find(
      (device) => device.device_id === preferredDeviceId
    );
    if (!preferred) {
      throw new Error(
        `Configured MATRIX_AUTO_VERIFY_TARGET_DEVICE_ID=${preferredDeviceId} was not found among your active devices`
      );
    }
    return preferred;
  }

  const [latest] = candidates.sort(
    (a, b) => (b.last_seen_ts ?? 0) - (a.last_seen_ts ?? 0)
  );
  if (!latest) {
    throw new Error(
      "No other own Matrix device found to verify against. Log in with Element on another device first."
    );
  }

  return latest;
}

async function fetchOwnDevices(): Promise<OwnDevice[]> {
  const config = getConfig();
  const response = await fetch(
    `${config.MATRIX_HOMESERVER_URL}/_matrix/client/v3/devices`,
    {
      headers: {
        Authorization: `Bearer ${config.MATRIX_ACCESS_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to load own devices: ${response.status} ${await response.text()}`
    );
  }

  const body = (await response.json()) as { devices?: OwnDevice[] };
  return body.devices ?? [];
}

function isDehydratedDevice(device: OwnDevice): boolean {
  return device.display_name?.toLowerCase().includes("dehydrated") ?? false;
}

export function waitForInitialSync(sdk: SDKClient): Promise<void> {
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
        `Unsupported verification method ${request.chosenMethod}; only ${SAS_METHOD} is supported`
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

function printEmojis(emoji: EmojiMapping[]): void {
  console.log("\n======================================================");
  console.log(" SAS-EMOJIS (mit Element vergleichen!):");
  console.log("======================================================");
  console.log(`  ${emoji.map(([symbol]) => symbol).join("   ")}`);
  console.log(`  (${emoji.map(([, name]) => name).join(", ")})`);
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

async function promptYesNo(
  question: string,
  responseFile?: string
): Promise<boolean> {
  const httpWaiter = createHttpConfirmationWaiter(question);
  const waiters: Promise<boolean>[] = [httpWaiter.promise];

  if (responseFile) {
    waiters.push(waitForYesNoFile(responseFile, question));
  } else if (process.stdin.isTTY) {
    waiters.push(waitForYesNoStdin(question));
  }

  try {
    return await Promise.race(waiters);
  } finally {
    httpWaiter.dispose();
  }
}

async function waitForYesNoFile(
  responseFile: string,
  question: string
): Promise<boolean> {
  await ensureFreshResponseFile(responseFile);

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

function waitForYesNoStdin(question: string): Promise<boolean> {
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

async function ensureFreshResponseFile(responseFile: string): Promise<void> {
  await fs.mkdir(path.dirname(responseFile), { recursive: true });
  try {
    await fs.unlink(responseFile);
  } catch (err) {
    if (!isFileNotFoundError(err)) throw err;
  }
}

async function writeStatusFile(
  statusFile: string | undefined,
  status: VerificationStatusFile
): Promise<void> {
  if (!statusFile) return;
  await fs.mkdir(path.dirname(statusFile), { recursive: true });
  await fs.writeFile(statusFile, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function readStatusFile(
  statusFile: string | undefined
): Promise<VerificationStatusFile | null> {
  if (!statusFile) return null;

  try {
    const raw = await fs.readFile(statusFile, "utf8");
    return JSON.parse(raw) as VerificationStatusFile;
  } catch (err) {
    if (isFileNotFoundError(err)) return null;
    throw err;
  }
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHttpConfirmationWaiter(question: string): {
  promise: Promise<boolean>;
  dispose: () => void;
} {
  const token = randomBytes(16).toString("hex");
  const endpoint = "http://localhost:3000/verify/confirm";
  const confirmCommand =
    `curl -X POST ${endpoint} ` +
    `-H "Content-Type: application/json" ` +
    `-H "X-MatrixMind-Verify-Token: ${token}" ` +
    `-d '{"confirm":true}'`;
  const rejectCommand =
    `curl -X POST ${endpoint} ` +
    `-H "Content-Type: application/json" ` +
    `-H "X-MatrixMind-Verify-Token: ${token}" ` +
    `-d '{"confirm":false}'`;

  log.info(
    {
      endpoint,
      confirmCommand,
      rejectCommand,
    },
    "Confirm the SAS result with one of these commands"
  );

  const promise = new Promise<boolean>((resolve) => {
    pendingHttpConfirmation = {
      token,
      question,
      createdAt: new Date().toISOString(),
      resolve,
    };
  });
  mergeSnapshot({
    confirmationEndpoint: endpoint,
    confirmCommand,
    rejectCommand,
    updatedAt: new Date().toISOString(),
  });

  return {
    promise,
    dispose: () => {
      if (pendingHttpConfirmation?.token === token) {
        pendingHttpConfirmation = null;
      }
    },
  };
}

function updateSnapshot(snapshot: AutoVerificationSnapshot): void {
  autoVerificationSnapshot = snapshot;
}

function mergeSnapshot(snapshot: Partial<AutoVerificationSnapshot>): void {
  autoVerificationSnapshot = {
    ...autoVerificationSnapshot,
    ...snapshot,
  };
}

export function getAutoVerificationSnapshot(): AutoVerificationSnapshot {
  return autoVerificationSnapshot;
}

export function confirmPendingAutoVerification(
  confirm: boolean,
  token: string | undefined
): { ok: boolean; status: number; message: string } {
  if (!pendingHttpConfirmation) {
    return {
      ok: false,
      status: 409,
      message: "No auto verification is currently waiting for confirmation.",
    };
  }

  if (!token || token !== pendingHttpConfirmation.token) {
    return {
      ok: false,
      status: 403,
      message: "Invalid or missing verification token.",
    };
  }

  const pending = pendingHttpConfirmation;
  pendingHttpConfirmation = null;
  pending.resolve(confirm);
  return {
    ok: true,
    status: 200,
    message: confirm
      ? "Verification confirmation accepted."
      : "Verification rejection accepted.",
  };
}

async function logOwnDeviceTrust(
  crypto: CryptoApi,
  userId: string,
  deviceId: string | null | undefined
): Promise<void> {
  if (!deviceId) return;

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
