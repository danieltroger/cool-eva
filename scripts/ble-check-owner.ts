import assert from "node:assert/strict";
import {
  FrameAssembler,
  MessageKind,
  decodeMessage,
  parseEnvelope,
  splitIntoFrames,
  type RefusedHeader,
  type HelloHeader,
} from "../public/lib/ble-wire.js";
import { createRig, helloFrame, settle, until, within, PHONE, OTHER } from "./ble-check-rig.ts";

export async function checkBleOwner(): Promise<void> {
  await missingOwner(false);
  await missingOwner(true);
  await concurrentHello();
  await multipartHello();
}

async function missingOwner(hanging: boolean): Promise<void> {
  const rig = await createRig();
  try {
    await within(rig.client.chooseAndConnect(), "owner before missing-device lookup");
    rig.lookup(async () => {
      if (!hanging) {
        throw new Error("synthetic removed BlueZ device object");
      }
      return new Promise<boolean>(() => {
        /* The missing daemon never answers this call. */
      });
    });
    rig.write(await helloFrame(rig), OTHER);
    await until(() => rig.reads.length === 1, "correct proof initiated missing-owner read");
    if (hanging) {
      await rig.clock.advance(2_999);
      assert.equal(rig.server.stats().owner, PHONE, "owner released before the read deadline");
      await rig.clock.advance(1);
    }
    await until(
      () => rig.server.stats().owner === OTHER,
      hanging
        ? "timed-out owner read did not authenticate replacement"
        : "owner read error did not authenticate replacement"
    );
    assert.equal(rig.reads.length, 1);
  } finally {
    await rig.close();
  }
}

async function concurrentHello(): Promise<void> {
  const rig = await createRig();
  let release: (connected: boolean) => void = () => {
    throw new Error("lookup gate was not installed");
  };
  const lookup = new Promise<boolean>(resolve => {
    release = resolve;
  });
  try {
    await within(rig.client.chooseAndConnect(), "owner before concurrent HELLO");
    rig.lookup(async () => lookup);
    rig.write(await helloFrame(rig), OTHER);
    await until(() => rig.reads.length === 1, "first proved HELLO entered owner read");
    const second = await helloFrame(rig);
    const parsed = parseEnvelope(second.subarray(2));
    assert.equal(parsed.sealed, false);
    if (parsed.sealed) {
      throw new Error("expected a clear fixture");
    }
    const nonce = (decodeMessage(parsed.message).header as HelloHeader).clientNonce;
    const start = rig.frames.length;
    rig.write(second, "/org/bluez/hci0/dev_THIRD");
    await until(() => rig.server.stats().hellos === 1, "second proved HELLO settled during first lookup");
    assert.equal(rig.server.stats().owner, PHONE, "concurrent lookup released a live owner");
    assert.equal(rig.reads.length, 1, "concurrent HELLO started a duplicate owner read");
    await until(() => busyRefusal(rig.frames.slice(start), nonce), "concurrent proved HELLO received busy advisory");
    release(true);
    await until(() => rig.server.stats().hellos === 0, "live-owner lookup drained");
    assert.equal(rig.server.stats().owner, PHONE);
    assert.equal((await within(rig.client.tunnelRequest("/still-owner"), "owner remained usable")).status, 201);
  } finally {
    release(true);
    await rig.close();
  }
}

function busyRefusal(frames: Uint8Array<ArrayBuffer>[], nonce: string): boolean {
  const assembler = new FrameAssembler(1024);
  for (const frame of frames) {
    const { envelope } = assembler.push(frame);
    if (!envelope) continue;
    const parsed = parseEnvelope(envelope);
    if (parsed.sealed) continue;
    const message = decodeMessage(parsed.message);
    const header = message.header as RefusedHeader;
    if (
      message.kind === MessageKind.REFUSED &&
      header.clientNonce === nonce &&
      header.reason === "another phone is connected"
    ) {
      return true;
    }
  }
  return false;
}

async function multipartHello(): Promise<void> {
  const rig = await createRig();
  try {
    await within(rig.client.chooseAndConnect(), "owner before multipart HELLO");
    const informationBefore = new TextDecoder().decode(rig.handlers.onRead());
    const hello = await helloFrame(rig);
    for (const frame of splitIntoFrames(hello.subarray(2), 93, 40)) {
      rig.write(frame);
    }
    await until(() => rig.server.stats().inbound === 0, "multipart clear envelope drained");
    await settle();
    assert.equal(
      new TextDecoder().decode(rig.handlers.onRead()),
      informationBefore,
      "multipart owner HELLO bypassed server bookkeeping"
    );
    assert.equal(
      (await within(rig.client.tunnelRequest("/after-rejected-hello"), "old session survived rejected HELLO")).status,
      201
    );
  } finally {
    await rig.close();
  }
}
