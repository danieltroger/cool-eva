import { startBleServer } from "../src/ble-server/server.ts";
import assert from "node:assert/strict";
import { createBleLink } from "../public/lib/ble-link.js";
import { generateBleSecret, validBleSecret } from "../public/lib/ble-secret.js";
import { BleSession } from "../src/ble-server/session.ts";
import { MessageKind, PROTOCOL_VERSION, clearEnvelope, encodeMessage, randomNonce } from "../public/lib/ble-wire.js";
import { createRig, helloFrame, KEY } from "./ble-check-rig.ts";

export async function checkBleKeys(): Promise<void> {
  await startupKeys();
  originsAndKeys();
  await productionReplay();
}

function originsAndKeys(): void {
  for (const url of [
    "https://unconfigured.invalid/cool-eva/",
    "https://unconfigured.invalid/another/",
    "https://danieltroger.github.io.evil.invalid/",
    "https://other.github.io/",
    "cooleva://other/index.html",
  ]) {
    let storageRead = 0;
    let requested = 0;
    let removed = 0;
    const client = createBleLink({
      url: new URL(url),
      storage: {
        getItem: () => {
          storageRead++;
          return KEY;
        },
        setItem: () => {
          throw new Error("unsafe origin stored a key");
        },
        removeItem: () => {
          removed++;
        },
      },
      bluetooth: () => ({
        requestDevice: async () => {
          requested++;
          throw new Error("unsafe chooser");
        },
      }),
      shell: () => ({ platform: "ios", saveFile: async () => undefined }),
    });
    assert.equal(client.originAllowed(), false, `origin policy accepted ${url}`);
    assert.equal(client.storedSecret(), "");
    assert.throws(() => client.rememberSecret(KEY), /Bluetooth needs its own address/);
    assert.equal(storageRead, 0);
    assert.equal(requested, 0);
    assert.ok(removed > 0);
  }
  for (const url of [
    "https://danieltroger.github.io/cool-eva/",
    "http://localhost:8172/?transport=ble",
    "cooleva://app/index.html",
  ]) {
    const values = new Map<string, string>();
    const client = createBleLink({
      url: new URL(url),
      storage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: key => {
          values.delete(key);
        },
      },
      shell: () => ({ platform: "ios", saveFile: async () => undefined }),
    });
    assert.equal(client.originAllowed(), true, `allowed origin rejected ${url}`);
    client.rememberSecret(`\n ${KEY.toUpperCase()} \n`);
    assert.equal(client.storedSecret(), KEY);
    assert.throws(() => client.rememberSecret("not a generated key"));
    assert.equal(client.storedSecret(), KEY, "invalid paste replaced the saved key");
  }
  assert.equal(new URL("cooleva://app/index.html").origin, "null");
  const first = generateBleSecret();
  const second = generateBleSecret();
  assert.ok(validBleSecret(first) && validBleSecret(second));
  assert.notEqual(first, second, "production key generator is constant");
  const original = crypto.getRandomValues.bind(crypto);
  let requestedBytes = 0;
  crypto.getRandomValues = <ArrayType extends ArrayBufferView | null>(array: ArrayType): ArrayType => {
    if (!(array instanceof Uint8Array)) {
      throw new Error("unexpected random request");
    }
    requestedBytes = array.length;
    for (let index = 0; index < array.length; index++) {
      array[index] = index;
    }
    return array;
  };
  try {
    assert.equal(
      generateBleSecret(),
      Array.from({ length: 32 }, (_unused, index) => index.toString(16).padStart(2, "0")).join("")
    );
    assert.equal(requestedBytes, 32, "generator did not request the full key");
  } finally {
    crypto.getRandomValues = original;
  }
}
async function productionReplay(): Promise<void> {
  const rig = await createRig();
  try {
    const session = new BleSession(KEY);
    const frame = await helloFrame(rig);
    const first = await session.receive(frame.subarray(2));
    // The separate session has its own challenge; construct a proof for that session.
    assert.equal(first.startedSession, undefined);
    const own = new BleSession(KEY);
    const { helloProof } = await import("../public/lib/ble-wire.js");
    const clientNonce = randomNonce();
    const proof = await helloProof(KEY, own.info().serverNonce, clientNonce);
    const envelope = clearEnvelope(encodeMessage(MessageKind.HELLO, { version: PROTOCOL_VERSION, clientNonce, proof }));
    assert.equal((await own.receive(envelope)).startedSession, true);
    own.end();
    assert.equal((await own.receive(envelope)).startedSession, undefined, "recorded HELLO restarted a session");
  } finally {
    await rig.close();
  }
}

async function startupKeys(): Promise<void> {
  for (const secret of [
    "short",
    "a typed phrase that is definitely long enough",
    "A".repeat(64),
    "0".repeat(63),
    "0".repeat(65),
  ]) {
    await assert.rejects(
      startBleServer({
        secret,
        httpPort: 1,
        startGatt: async () => {
          throw new Error("radio called with invalid key");
        },
      }),
      /must be a generated 64-character/
    );
  }
}
