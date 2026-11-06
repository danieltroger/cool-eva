import type { CanMessage } from "socketcan";
import { ageMs, latestValue, recordArrival } from "../src/can/signals.ts";
import { monotonicNow } from "../src/monotonic.ts";
import type { PsuHold } from "../src/psu/hold.ts";
import { evaluateServiceGate, sampleServiceGate, serviceGateSignalKeys } from "../src/vcu/service-gate.ts";
import { reportTableType, toParameterRow, type VcuParameterSnapshot } from "../src/vcu/snapshot.ts";
import { createVcuWriteRunner } from "../src/vcu/write-runner.ts";
import { addressedReply, scriptedChannel } from "./can-transmit-fixtures.ts";

/** Synthetic parked readings and manually released replies; never opens a CAN socket. */
export function resetWriteFixture(directory: string, hold: PsuHold) {
  parkSyntheticBike();
  const queued: CanMessage[] = [];
  const waiting: ((frame: CanMessage) => void)[] = [];
  const holdAtSend: boolean[] = [];
  const bus = scriptedChannel(
    () => 16,
    frame => {
      holdAtSend.push(hold.status().on);
      const receiver = waiting.shift();
      if (receiver) {
        receiver(frame);
      } else {
        queued.push(frame);
      }
    }
  );
  const runner = createVcuWriteRunner({
    enabled: true,
    busIsActive: true,
    directory,
    channel: () => bus.channel,
    gate: () => evaluateServiceGate(sampleServiceGate(key => ({ value: latestValue(key), ageMs: ageMs(key) }))),
    latestSweep: async () => syntheticSweep(),
    holdPoller: async () => ({ release: () => {} }),
  });
  return {
    runner,
    bus,
    holdAtSend,
    nextRequest: (operation: Promise<unknown>): Promise<CanMessage> => {
      const frame = queued.shift();
      const request = frame ? Promise.resolve(frame) : new Promise<CanMessage>(resolve => waiting.push(resolve));
      return Promise.race([
        request,
        operation.then(result => {
          throw new Error(`Operation ended before the expected request: ${JSON.stringify(result)}`);
        }),
      ]);
    },
    reply: (payload: number[]) => runner.handleCanFrame(0x7e0, addressedReply(payload)),
  };
}

export function parkSyntheticBike(): void {
  for (const key of serviceGateSignalKeys()) {
    // These broadcasts prove a charger is awake even at zero; a parked bike has no fresh ones.
    const age = ["dc_v", "dc_a", "mains_v", "mains_a", "charge_manager_state"].includes(key) ? 60_000 : 0;
    recordArrival(key, 0, Date.UTC(2026, 0, 2, 3, 4, 5), monotonicNow() - age);
  }
}

function syntheticSweep() {
  const snapshot: VcuParameterSnapshot = {
    readAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    complete: false,
    micros: ["A9", "A8"],
    rows: [276, 277].map(index =>
      toParameterRow({
        index,
        identifier: 0x1000 | index,
        micro: index === 276 ? "A9" : "A8",
        status: "read",
        record: Uint8Array.of(0x40, 0x17),
        flowControlLatency: null,
      })
    ),
  };
  return { snapshot, report: reportTableType(snapshot) };
}
