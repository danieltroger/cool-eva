import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { appendReading, closeEncryptedLog, initEncryptedLog } from "../src/storage/encrypted-log.ts";
import { generateLogKeyPair, type LogKeyPair } from "../workers/keys/public/key-crypto.js";

export async function checkLogKeyRoundTrip(pair: LogKeyPair): Promise<void> {
  checkKeyEncoding(pair);
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-key-check-"));
  try {
    const publicPath = join(directory, "recipient.public.pem");
    const privatePath = join(directory, "recipient.private.pem");
    const logDirectory = join(directory, "sealed");
    await writeFile(publicPath, pair.publicPem);
    await writeFile(privatePath, pair.privatePem, { mode: 0o600 });
    assert.ok(
      await initEncryptedLog({
        publicKeyPath: publicPath,
        directory: logDirectory,
        clockTrust: () => "satellite-backed",
      })
    );
    const timestamp = Date.UTC(2026, 0, 2, 12);
    appendReading(timestamp, "fixture_charge", 64, "%", "fixture", "stream");
    appendReading(timestamp + 1000, "fixture_charge", 63, "%", "fixture", "stream");
    await closeEncryptedLog();
    const outputPath = join(directory, "opened.db");
    await decrypt(logDirectory, privatePath, outputPath);
    const database = new Database(outputPath, { readonly: true });
    try {
      const rows = database
        .prepare(
          "SELECT ts, value, key, unit, grp, source, clock_trust FROM reading JOIN signal ON signal.id = reading.signal_id ORDER BY seq"
        )
        .all();
      assert.deepEqual(rows, [
        {
          ts: timestamp,
          value: 64,
          key: "fixture_charge",
          unit: "%",
          grp: "fixture",
          source: "stream",
          clock_trust: "satellite-backed",
        },
        {
          ts: timestamp + 1000,
          value: 63,
          key: "fixture_charge",
          unit: "%",
          grp: "fixture",
          source: "stream",
          clock_trust: "satellite-backed",
        },
      ]);
    } finally {
      database.close();
    }
    const stranger = await generateLogKeyPair();
    await writeFile(privatePath, stranger.privatePem, { mode: 0o600 });
    await assert.rejects(
      decrypt(logDirectory, privatePath, join(directory, "wrong-key.db")),
      error => {
        const failure = error as Error & { code?: number; stderr?: string };
        return failure.code === 2 && failure.stderr?.includes("could not be decrypted") === true;
      },
      "another private key must not decrypt the segment"
    );
  } finally {
    await closeEncryptedLog();
    await rm(directory, { recursive: true, force: true });
  }
}

export function checkKeyEncoding(pair: LogKeyPair): void {
  const privateKey = createPrivateKey(pair.privatePem);
  const publicKey = createPublicKey(pair.publicPem);
  assert.equal(privateKey.asymmetricKeyType, "x25519");
  assert.equal(publicKey.asymmetricKeyType, "x25519");
  assert.ok(
    privateKey.export({ type: "pkcs8", format: "pem" }) === pair.privatePem,
    "private PEM must match Node's PKCS8 export byte-for-byte"
  );
  assert.ok(
    publicKey.export({ type: "spki", format: "pem" }) === pair.publicPem,
    "public PEM must match Node's SPKI export byte-for-byte"
  );
  assert.ok(
    createPublicKey(privateKey).export({ type: "spki", format: "pem" }) === pair.publicPem,
    "the exported public and private keys must be one pair"
  );
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  assert.equal(publicDer.length, 44);
  assert.equal(privateKey.export({ type: "pkcs8", format: "der" }).length, 48);
  assert.equal(publicDer.subarray(0, 12).toString("hex"), "302a300506032b656e032100");
  assert.equal(pair.fingerprint, createHash("sha256").update(publicDer).digest("hex"));
}

async function decrypt(inputPath: string, privatePath: string, outputPath: string): Promise<void> {
  const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  await promisify(execFile)(
    process.execPath,
    ["--experimental-strip-types", join(projectDirectory, "scripts/decrypt-log.ts"), inputPath, "--out", outputPath],
    {
      cwd: projectDirectory,
      env: { ...process.env, RIDE_LOG_PRIVATE_KEY: privatePath },
      timeout: 30_000,
    }
  );
}

// A downloaded synthetic pair can be checked without uploading either file to a server.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [privatePath, publicPath] = process.argv.slice(2);
  assert.ok(privatePath && publicPath, "usage: log-key-roundtrip.ts <synthetic-private.pem> <synthetic-public.pem>");
  const privatePem = await readFile(privatePath, "utf8");
  const publicPem = await readFile(publicPath, "utf8");
  const fingerprint = createHash("sha256")
    .update(createPublicKey(publicPem).export({ type: "spki", format: "der" }))
    .digest("hex");
  await checkLogKeyRoundTrip({ privatePem, publicPem, fingerprint });
  console.log("✓ downloaded synthetic PEM files seal and decrypt with the production recorder and CLI");
}
