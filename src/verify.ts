import readline from "node:readline";
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

const log = getLogger("verify");

const SAS_METHOD = "m.sas.v1";

async function main(): Promise<void> {
  const targetUser = process.argv[2];
  if (!targetUser || !/^@[^:]+:.+$/.test(targetUser)) {
    console.error("Usage: verify <@user:server>");
    console.error("Example: verify @hannes:quassel.io");
    process.exit(1);
  }

  const client = new MatrixClient();
  await client.start();

  // Wait for initial sync so we know which rooms we share with the target.
  const sdk = client.getSDKClient();
  await waitForSync(sdk);
  log.info("Initial sync complete");

  const roomId = findDMRoom(sdk, targetUser);
  if (!roomId) {
    console.error(
      `No joined room found with ${targetUser}. Make sure the bot shares a room with this user.`
    );
    process.exit(1);
  }
  log.info({ roomId, targetUser }, "Starting verification in DM room");

  const crypto = sdk.getCrypto();
  if (!crypto) throw new Error("Crypto not initialised");

  // Listen for incoming verification events so we can react if the remote
  // side starts the flow before we do (e.g. by clicking "Verify" on a
  // request we already sent).
  const incoming = new Promise<VerificationRequest>((resolve) => {
    sdk.on(CryptoEvent.VerificationRequestReceived, (req) => {
      if (req.otherUserId === targetUser) resolve(req);
    });
  });

  const outgoing = await crypto.requestVerificationDM(targetUser, roomId);
  log.info(
    { transactionId: outgoing.transactionId },
    "Verification request sent – check Element and accept the prompt"
  );

  const request = await Promise.race([
    waitForReady(outgoing),
    incoming.then(waitForReady),
  ]);

  log.info({ phase: request.phase }, "Request ready – starting SAS");
  const verifier = await request.startVerification(SAS_METHOD);

  const emoji = await showEmojis(verifier);
  printEmojis(emoji);

  const userOk = await promptYesNo(
    "Stimmen die Emojis mit denen in Element überein? [y/N] "
  );
  if (!userOk) {
    log.warn("User reported mismatch – cancelling");
    const sas = verifier.getShowSasCallbacks();
    if (sas) {
      sas.mismatch();
    } else {
      await request.cancel({ reason: "emoji mismatch" });
    }
    process.exit(2);
  }

  const sas = verifier.getShowSasCallbacks();
  if (!sas) throw new Error("SAS callbacks gone");
  await sas.confirm();
  log.info("Local confirmation sent – waiting for remote confirmation…");

  await waitForDone(request);
  log.info({ phase: request.phase }, "Verification complete");

  await client.stop();
  process.exit(0);
}

function waitForSync(
  sdk: ReturnType<MatrixClient["getSDKClient"]>
): Promise<void> {
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

function findDMRoom(
  sdk: ReturnType<MatrixClient["getSDKClient"]>,
  targetUser: string
): string | undefined {
  for (const room of sdk.getRooms()) {
    const members = room.getJoinedMembers().map((m) => m.userId);
    if (members.includes(targetUser) && members.length <= 2) return room.roomId;
  }
  // Fallback: any joined room with that user
  for (const room of sdk.getRooms()) {
    if (room.getJoinedMembers().some((m) => m.userId === targetUser)) {
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
        request.off(VerificationRequestEvent.Change, onChange);
        resolve();
      } else if (
        request.phase === VerificationPhase.Cancelled ||
        request.phase === VerificationPhase.Done
      ) {
        request.off(VerificationRequestEvent.Change, onChange);
        reject(new Error(`Verification ended in phase ${request.phase}`));
      }
    };
    request.on(VerificationRequestEvent.Change, onChange);
    // Check immediately in case phase already advanced before we registered the listener
    onChange();
  });
  return request;
}

function showEmojis(verifier: Verifier): Promise<EmojiMapping[]> {
  return new Promise((resolve, reject) => {
    const existing = verifier.getShowSasCallbacks();
    if (existing?.sas.emoji) return resolve(existing.sas.emoji);

    verifier.on(VerifierEvent.ShowSas, (cb: ShowSasCallbacks) => {
      if (cb.sas.emoji) resolve(cb.sas.emoji);
      else reject(new Error("Verifier did not produce emoji SAS"));
    });
    verifier.on(VerifierEvent.Cancel, (e) => {
      reject(e instanceof Error ? e : new Error("Verification cancelled"));
    });
    verifier.verify().catch(reject);
  });
}

function printEmojis(emoji: EmojiMapping[]): void {
  console.log("\n======================================================");
  console.log(" SAS-EMOJIS (mit Element vergleichen!):");
  console.log("======================================================");
  const line = emoji.map(([e]) => e).join("   ");
  const names = emoji.map(([, n]) => n).join(", ");
  console.log(`  ${line}`);
  console.log(`  (${names})`);
  console.log("======================================================\n");
}

function waitForDone(request: VerificationRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const onChange = (): void => {
      if (request.phase === VerificationPhase.Done) {
        request.off(VerificationRequestEvent.Change, onChange);
        resolve();
      } else if (request.phase === VerificationPhase.Cancelled) {
        request.off(VerificationRequestEvent.Change, onChange);
        reject(new Error("Verification cancelled by remote"));
      }
    };
    request.on(VerificationRequestEvent.Change, onChange);
    // Check immediately in case the request is already in a terminal phase
    onChange();
  });
}

function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// Surface config errors up front
getConfig();

main().catch((err) => {
  log.error({ err }, "Verification failed");
  process.exit(1);
});
