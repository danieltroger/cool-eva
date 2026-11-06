import { startBleServer } from "../src/ble-server/server.ts";
import assert from "node:assert/strict";
import { createBleLink } from "../public/lib/ble-link.js";
import { generateBleSecret, validBleSecret } from "../public/lib/ble-secret.js";
import { BleSession } from "../src/ble-server/session.ts";
import { MessageKind, PROTOCOL_VERSION, clearEnvelope, encodeMessage, randomNonce } from "../public/lib/ble-wire.js";
import { createRig, helloFrame, KEY } from "./ble-check-rig.ts";

export async function checkBleKeys(): Promise<void> {
  await startupKeys();
  await originsAndKeys();
  await productionReplay();
}

async function originsAndKeys(): Promise<void> {
  for (const url of [
    "https://danieltroger.github.io/",
    "https://danieltroger.github.io/cool-eva/",
    "https://danieltroger.github.io/another/",
    "https://unconfigured.invalid/cool-eva/",
    "https://unconfigured.invalid/another/",
    "https://cool-eva-keys.cool-eva.workers.dev/",
    "https://other.cool-eva.workers.dev/",
    "https://preview-cool-eva-dashboard.cool-eva.workers.dev/",
    "https://cool-eva-dashboard.cool-eva.workers.dev.evil.invalid/",
    "http://cool-eva-dashboard.cool-eva.workers.dev/",
    "https://cool-eva-dashboard.cool-eva.workers.dev:8443/",
    "cooleva://other/index.html",
    "cooleva://app:8443/index.html",
    "file:///index.html",
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
    await assert.rejects(client.chooseAndConnect(), /Bluetooth needs its own address/);
    assert.equal(storageRead, 0);
    assert.equal(requested, 0);
    assert.ok(removed > 0);
  }
  for (const url of [
    "https://cool-eva-dashboard.cool-eva.workers.dev/",
    "https://cool-eva-dashboard.cool-eva.workers.dev:443/index.html",
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
    values.set("cool-eva.ble-secret", "a legacy typed phrase");
    assert.equal(client.storedSecret(), "", "legacy phrase was offered for authentication");
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
    const first = await session.verifyHello(frame.subarray(2));
    // The separate session has its own challenge; construct a proof for that session.
    assert.equal(first.hello, undefined);
    const own = new BleSession(KEY);
    const { helloProof } = await import("../public/lib/ble-wire.js");
    const clientNonce = randomNonce();
    const proof = await helloProof(KEY, own.info().serverNonce, clientNonce);
    const envelope = clearEnvelope(encodeMessage(MessageKind.HELLO, { version: PROTOCOL_VERSION, clientNonce, proof }));
    const verified = await own.verifyHello(envelope);
    assert.ok(verified.hello);
    assert.equal((await own.commitHello(verified.hello)).startedSession, true);
    own.end();
    const replay = await own.verifyHello(envelope);
    const result = replay.hello ? await own.commitHello(replay.hello) : replay;
    assert.equal(result.startedSession, undefined, "recorded HELLO restarted a session");
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
