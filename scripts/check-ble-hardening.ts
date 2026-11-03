import { checkNotificationSizes } from "./ble-check-framing.ts";
import { checkBleBudgets } from "./ble-check-budgets.ts";
import { checkBleOwner } from "./ble-check-owner.ts";
import { checkBleFailures } from "./ble-check-errors.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  FrameAssembler,
  MessageKind,
  PROTOCOL_VERSION,
  clearEnvelope,
  encodeMessage,
  sealEnvelope,
  splitIntoFrames,
  Direction,
  randomNonce,
} from "../public/lib/ble-wire.js";
import { BleSession, type ReceiveResult, type VerifiedHello } from "../src/ble-server/session.ts";
import { createRig, helloFrame, capturedKey, within, settle, until, KEY, PHONE, OTHER } from "./ble-check-rig.ts";

export async function checkBleHardening(): Promise<void> {
  await preAuthentication();
  await ownerIsolation();
  await checkBleOwner();
  for (const mtu of [23, 185, 517]) {
    await checkNotificationSizes(mtu);
  }
  await ownerStorage();
  await ownerLifetime();
  await staleCommit();
  await checkBleBudgets();
  await checkBleFailures();
  console.log("check-ble-hardening: all checks passed");
}

async function preAuthentication(): Promise<void> {
  const rig = await createRig();
  try {
    rig.write(await helloFrame(rig, "f".repeat(64)), OTHER);
    await settle();
    const notHello = splitIntoFrames(clearEnvelope(encodeMessage(MessageKind.REQUEST, {})), 1, 180)[0];
    for (let index = 0; index < 5_000; index++) {
      rig.write(notHello, OTHER);
    }
    await settle();
    const proper = await helloFrame(rig);
    const oversized = new Uint8Array(513);
    oversized.set(proper);
    rig.write(oversized);
    for (const flags of [1, 2, 0]) {
      const partial = proper.slice();
      partial[0] = flags;
      rig.write(partial);
    }
    rig.write(new Uint8Array([1, 42, 0]), OTHER);
    for (let index = 0; index < 100_000; index++) {
      rig.write(new Uint8Array([0, 42]), OTHER);
    }
    await settle();
    assert.equal(rig.server.stats().owner, null, "partial or oversized pre-auth HELLO authenticated");
    assert.equal(rig.server.stats().hellos, 0, "pre-auth fragments retained asynchronous work");
    assert.equal(rig.server.stats().queuedBytes, 0, "unsubscribed refusals retained output");
    rig.subscribe();
    await settle();
    assert.equal(rig.frames.length, 0, "subscription replayed an unauthenticated backlog");
    const initialOwner = rig.server.stats().owner;
    for (const invalid of ["", "00", "0".repeat(30), "0".repeat(34)]) {
      rig.write(await helloFrame(rig, KEY, invalid));
    }
    for (const invalid of ["", "00", "0".repeat(31), "0".repeat(33), "AB".repeat(16)]) {
      rig.write(
        splitIntoFrames(
          clearEnvelope(
            encodeMessage(MessageKind.HELLO, { version: PROTOCOL_VERSION, clientNonce: invalid, proof: "0".repeat(64) })
          ),
          5,
          512
        )[0]
      );
    }
    await settle();
    assert.equal(rig.server.stats().owner, initialOwner, "invalid nonce established a session");
    for (let index = 0; index < 8; index++) {
      rig.write(await helloFrame(rig, "f".repeat(64)), OTHER);
    }
    await until(() => rig.server.stats().hellos === 0, "failed proof work drained");
    rig.write(await helloFrame(rig));
    await until(() => rig.server.stats().owner === PHONE, "valid HELLO after wrong proofs");
    assert.ok(rig.frames.length === 0 || rig.frames.every(frame => frame.length <= 180));
    rig.handlers.onSubscribed(false);
    rig.write(await helloFrame(rig, "f".repeat(64)), OTHER);
    await settle();
    assert.equal(rig.server.stats().queuedBytes, 0, "unsubscribe retained refusal frames");
  } finally {
    await rig.close();
  }
}
async function ownerIsolation(): Promise<void> {
  const rig = await createRig();
  try {
    await within(rig.client.chooseAndConnect(), "owner authentication");
    let status = "";
    rig.client.onBleStatus(value => {
      status = value;
    });
    rig.lookup(async () => {
      throw new Error("synthetic connection read error");
    });
    rig.write(await helloFrame(rig, "f".repeat(64)), OTHER);
    await settle();
    assert.equal(rig.reads.length, 0, "wrong proof initiated an owner read");
    assert.equal(rig.server.stats().owner, PHONE, "wrong proof released the owner");
    assert.equal(status, "connected", "broadcast refusal ended the client's session");
    rig.lookup(
      () =>
        new Promise<boolean>(() => {
          /* Deliberately never answers. */
        })
    );
    rig.write(await helloFrame(rig, "f".repeat(64)), OTHER);
    await settle();
    assert.equal(rig.reads.length, 0, "wrong proof initiated a potentially hanging owner read");
    assert.equal(rig.server.stats().owner, PHONE);
    rig.lookup(async () => true);
    rig.write(await helloFrame(rig), OTHER);
    await until(() => rig.reads.length === 1, "proved foreign HELLO liveness read");
    await settle();
    assert.equal(rig.server.stats().owner, PHONE, "live owner was displaced");
    assert.equal(status, "connected", "busy advisory ended a live session");
    rig.hook(frame => {
      if (frame[0] & 1 && frame[2] === 1) {
        rig.write(new Uint8Array([1, 199, 0]), OTHER, 517);
        rig.write(new Uint8Array([0]), OTHER, 517);
      }
      // Leave the foreign MTU last even after LAST, before the asynchronous response is framed.
      rig.write(new Uint8Array([0, 199]), OTHER, 517);
    });
    const body = randomBytes(2_000).toString("hex");
    const response = await within(
      rig.client.tunnelRequest("/interleaved", { method: "POST", body }),
      "interleaved request"
    );
    assert.ok(
      rig.frames.every(frame => frame.length <= 180),
      "foreign MTU changed owner notification size"
    );
    assert.equal(new TextDecoder().decode(response.body), body, "foreign frame corrupted owner assembly");
    assert.equal(rig.calls.filter(path => path === "/interleaved").length, 1);
    rig.hook(null);
    rig.lookup(async () => false);
    rig.write(await helloFrame(rig), OTHER);
    await until(() => rig.server.stats().owner === OTHER, "proved replacement for absent owner");
  } finally {
    await rig.close();
  }
}
async function ownerStorage(): Promise<void> {
  const rig = await createRig();
  try {
    await within(rig.client.chooseAndConnect(), "owner for empty continuations");
    const key = await capturedKey(rig);
    const envelope = await sealEnvelope(
      key,
      Direction.TO_PI,
      0,
      encodeMessage(MessageKind.REQUEST, { id: 901, method: "POST", path: "/forbidden", headers: {} })
    );
    const first = new Uint8Array([1, 88, ...envelope.subarray(0, 10)]);
    rig.write(first);
    for (let index = 0; index < 100_000; index++) {
      rig.write(new Uint8Array([0, 88]));
    }
    rig.write(new Uint8Array([2, 88, ...envelope.subarray(10)]));
    await settle();
    assert.equal(rig.calls.includes("/forbidden"), false, "empty continuations completed a forbidden envelope");
    const answer = await within(rig.client.tunnelRequest("/fresh"), "fresh request after rejected fragments");
    assert.equal(answer.status, 201);
  } finally {
    await rig.close();
  }
  const assembler = new FrameAssembler(20 * 1024);
  let complete = false;
  for (const frame of splitIntoFrames(new Uint8Array(20 * 1024 + 1), 1, 180)) {
    complete ||= assembler.push(frame).envelope !== undefined;
  }
  assert.equal(complete, false, "oversized payload was assembled");
}
async function ownerLifetime(): Promise<void> {
  const rig = await createRig();
  try {
    await within(rig.client.chooseAndConnect(), "lifecycle owner");
    rig.handlers.onDeviceDisconnected(OTHER);
    assert.equal(rig.server.stats().owner, PHONE);
    rig.write(await helloFrame(rig));
    await settle();
    assert.equal(rig.server.stats().owner, PHONE, "same-path page reload could not re-HELLO");
    assert.equal(rig.reads.length, 0, "same path unnecessarily read owner connectivity");
    rig.handlers.onDeviceDisconnected(PHONE);
    assert.equal(rig.server.stats().owner, null, "owner disconnect depended on aggregate unsubscribe");
    rig.write(await helloFrame(rig));
    await until(() => rig.server.stats().owner === PHONE, "same-path reconnect");
    rig.handlers.onReset("bluetoothd owner changed");
    assert.equal(rig.server.stats().owner, null);
    rig.write(await helloFrame(rig), OTHER);
    await until(() => rig.server.stats().owner === OTHER, "new path after daemon replacement");
  } finally {
    await rig.close();
  }
}
async function staleCommit(): Promise<void> {
  const session = new DelayedCommit(KEY);
  const rig = await createRig({ session });
  try {
    const originalNonce = session.info().serverNonce;
    rig.write(await helloFrame(rig));
    await until(() => session.entered, "delayed verified handshake");
    rig.handlers.onReset("device removed before key commit");
    session.release();
    await settle();
    assert.equal(rig.server.stats().owner, null, "stale proof committed ownership");
    assert.equal(session.authenticated, false, "stale proof committed crypto state");
    assert.equal(session.info().serverNonce, originalNonce, "stale proof rotated nonce");
  } finally {
    session.release();
    await rig.close();
  }
}
class DelayedCommit extends BleSession {
  entered = false;
  #release: () => void = () => {
    throw new Error("gate not installed");
  };
  #gate = new Promise<void>(resolve => {
    this.#release = resolve;
  });
  release(): void {
    this.#release();
  }
  override async commitHello(hello: VerifiedHello, current: () => boolean = () => true): Promise<ReceiveResult> {
    this.entered = true;
    await this.#gate;
    return super.commitHello(hello, current);
  }
}

await checkBleHardening();
