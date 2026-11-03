import assert from "node:assert/strict";
import {
  MessageKind,
  Direction,
  encodeMessage,
  sealEnvelope,
  splitIntoFrames,
  type Bytes,
} from "../public/lib/ble-wire.js";
import { BleSession, type HelloResult, type ReceiveResult } from "../src/ble-server/session.ts";
import { Rejections } from "../src/ble-server/rejections.ts";
import { bleClock } from "./ble-check-clock.ts";
import { createRig, capturedKey, helloFrame, until, within, KEY } from "./ble-check-rig.ts";

export async function checkBleFailures(): Promise<void> {
  await rejectionTail();
  for (const operation of ["HELLO", "inbound message", "tunnel", "seal"] as const) {
    await internalFailure(operation);
  }
}

async function rejectionTail(): Promise<void> {
  const clock = bleClock();
  const rejections = new Rejections(clock, clock.now);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.join(" "));
  };
  try {
    rejections.problem("first stranger frame", clock.now());
    await clock.advance(500);
    rejections.problem("last stranger reason", clock.now());
    await clock.advance(1_499);
    assert.equal(lines.length, 1, "summary flushed before its window ended");
    await clock.advance(1);
    assert.equal(lines.length, 2, "last rejection reason never flushed without another frame");
    assert.match(lines[1], /last stranger reason/);
    assert.equal(clock.count(), 0, "summary retained its fired timer");
    rejections.problem("shutdown tail", clock.now());
    rejections.flush();
    assert.equal(clock.count(), 0, "stop flush retained a summary timer");
    await clock.advance(2_000);
    assert.equal(lines.length, 3, "a stopped summary printed again");
  } finally {
    rejections.flush();
    console.log = originalLog;
  }
}

async function internalFailure(operation: FailureOperation): Promise<void> {
  const session = new FailingSession(KEY);
  const rig = await createRig({ session });
  const lines: string[] = [];
  const warnings: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...values: unknown[]) => {
    lines.push(values.join(" "));
  };
  console.warn = (...values: unknown[]) => {
    warnings.push(values.join(" "));
  };
  try {
    await within(rig.client.chooseAndConnect(), "owner before synthetic internal failure");
    rig.write(new Uint8Array([0]));
    assert.ok(lines.some(line => line.includes("invalid frame or missing device")));
    await rig.clock.advance(500);
    session.operation = operation;
    if (operation === "HELLO") {
      rig.write(await helloFrame(rig));
    } else {
      const key = await capturedKey(rig);
      const envelope = await sealEnvelope(
        key,
        Direction.TO_PI,
        0,
        encodeMessage(MessageKind.REQUEST, { id: 91, method: "GET", path: "/internal-failure", headers: {} })
      );
      for (const frame of splitIntoFrames(envelope, 52, 180)) {
        rig.write(frame);
      }
    }
    await until(() => session.failures > 0, "synthetic internal failure reached production handling");
    await rig.clock.advance(0);
    assert.ok(
      warnings.some(line => line.includes(`${operation} failed (`) && line.includes(`synthetic ${operation} failure`)),
      `${operation} failure was not logged promptly under its own reason`
    );
    assert.equal(
      lines.some(line => line.includes(`synthetic ${operation} failure`)),
      false,
      "internal failure entered the stranger summary"
    );
  } finally {
    await rig.close();
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

type FailureOperation = "HELLO" | "inbound message" | "tunnel" | "seal";
class FailingSession extends BleSession {
  operation: FailureOperation | null = null;
  failures = 0;

  override async verifyHello(envelope: Bytes): Promise<HelloResult> {
    this.#fail("HELLO");
    return super.verifyHello(envelope);
  }

  override async receive(envelope: Bytes, current: () => boolean = () => true): Promise<ReceiveResult> {
    this.#fail("inbound message");
    const result = await super.receive(envelope, current);
    if (this.operation === "tunnel") {
      for (const message of result.messages) {
        message.body = new Proxy(message.body, {
          get: (target, property) => {
            if (property === "length") {
              this.#fail("tunnel");
            }
            return Reflect.get(target, property, target);
          },
        });
      }
    }
    return result;
  }

  override async seal(kind: number, header: unknown, body?: Bytes): Promise<Bytes | null> {
    this.#fail("seal");
    return super.seal(kind, header, body);
  }

  #fail(operation: FailureOperation): void {
    if (this.operation === operation) {
      this.failures++;
      throw new Error(`synthetic ${operation} failure`);
    }
  }
}
