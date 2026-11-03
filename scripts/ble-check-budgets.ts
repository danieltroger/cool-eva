import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MessageKind, encodeMessage, sealEnvelope, splitIntoFrames, Direction } from "../public/lib/ble-wire.js";
import { BleSession, type ReceiveResult } from "../src/ble-server/session.ts";
import { Admission } from "../src/ble-server/admission.ts";
import { OutboundQueue } from "../src/ble-server/outbound.ts";
import { Rejections } from "../src/ble-server/rejections.ts";
import { createRig, capturedKey, within, settle, until, KEY } from "./ble-check-rig.ts";

export async function checkBleBudgets(): Promise<void> {
  budgets();
  await actualAdmission(false);
  await actualAdmission(true);
  await pendingSeals();
}

function budgets(): void {
  const count = new Admission();
  for (let index = 0; index < 32; index++) {
    assert.equal(count.take(1), true);
  }
  assert.equal(count.take(1), false, "count admission allowed the excess message");
  const bytes = new Admission();
  assert.equal(bytes.take(65_536), true);
  assert.equal(bytes.take(65_536), true);
  assert.equal(bytes.take(1), false, "byte admission allowed excess storage below count limit");
  bytes.release(65_536);
  assert.equal(bytes.take(10), true, "released byte budget was not reusable");
  const queue = new OutboundQueue({
    send: () => {
      throw new Error("queue should not drain before start");
    },
  });
  assert.equal(queue.enqueue(new Uint8Array(116_508)), true, "exact framed fit was rejected");
  const before = queue.bufferedBytes;
  assert.equal(queue.enqueue(new Uint8Array(1)), false, "output cap did not reject overflow");
  assert.equal(queue.bufferedBytes, before, "overflow partially enqueued an envelope");
  queue.stop();
  assert.equal(queue.bufferedBytes, 0);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.join(" "));
  };
  try {
    const rejections = new Rejections();
    for (let index = 0; index < 1_000; index++) {
      rejections.problem("synthetic failure", 0);
    }
    rejections.problem("another failure", 2_001);
    rejections.problem("final failure", 2_002);
    rejections.flush();
    assert.equal(lines.length, 3, "rejection log was not windowed");
    assert.equal(
      lines.reduce((sum, line) => sum + Number(line.match(/rejected (\d+)/)?.[1] ?? 0), 0),
      1_002,
      "suppression lost failures"
    );
    const limiter = new Rejections();
    assert.deepEqual(
      Array.from({ length: 5 }, () => limiter.allowRefusal(0)),
      [true, true, true, true, false],
      "refusal burst budget exceeded"
    );
    assert.equal(limiter.allowRefusal(2_000), true);
  } finally {
    console.log = originalLog;
  }
}
class DelayedReceive extends BleSession {
  #release: () => void = () => {
    throw new Error("gate not installed");
  };
  #gate = new Promise<void>(resolve => {
    this.#release = resolve;
  });
  release(): void {
    this.#release();
  }
  override async receive(
    envelope: Uint8Array<ArrayBuffer>,
    current: () => boolean = () => true
  ): Promise<ReceiveResult> {
    await this.#gate;
    return super.receive(envelope, current);
  }
}
async function actualAdmission(large: boolean): Promise<void> {
  const session = new DelayedReceive(KEY);
  const rig = await createRig({ session });
  try {
    await within(rig.client.chooseAndConnect(), "admission owner");
    const key = await capturedKey(rig);
    for (let counter = 0; counter < 40; counter++) {
      const envelope = await sealEnvelope(
        key,
        Direction.TO_PI,
        counter,
        encodeMessage(MessageKind.UNSUBSCRIBE, {}, large ? randomBytes(18_000) : undefined)
      );
      for (const frame of splitIntoFrames(envelope, counter, 180)) {
        rig.write(frame);
      }
    }
    const stats = rig.server.stats();
    assert.equal(
      stats.inbound,
      large ? 7 : 32,
      large ? "actual byte admission grew without bound" : "actual count admission grew without bound"
    );
    session.release();
    await until(() => rig.server.stats().inbound === 0, "admission cleanup");
  } finally {
    session.release();
    await rig.close();
  }
}
class DelayedSeal extends BleSession {
  #release: () => void = () => {
    throw new Error("gate not installed");
  };
  #gate = new Promise<void>(resolve => {
    this.#release = resolve;
  });
  release(): void {
    this.#release();
  }
  override async seal(
    kind: number,
    header: unknown,
    body?: Uint8Array<ArrayBuffer>
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    await this.#gate;
    return super.seal(kind, header, body);
  }
}
async function pendingSeals(): Promise<void> {
  const session = new DelayedSeal(KEY);
  const rig = await createRig({ session });
  try {
    await within(rig.client.chooseAndConnect(), "pending seals owner");
    const key = await capturedKey(rig);
    for (let counter = 0; counter < 50; counter++) {
      const envelope = await sealEnvelope(
        key,
        Direction.TO_PI,
        counter,
        encodeMessage(MessageKind.REQUEST, { id: counter, method: "GET", path: "/held", headers: {} })
      );
      for (const frame of splitIntoFrames(envelope, counter, 180)) {
        rig.write(frame);
      }
    }
    await settle();
    assert.equal(rig.server.stats().owner, null, "pending seal overload did not end the session");
    session.release();
    await until(() => rig.server.stats().seals === 0, "pending seal release");
  } finally {
    session.release();
    await rig.close();
  }
}
