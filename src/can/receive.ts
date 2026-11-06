import type { CanMessage, RxFilter } from "socketcan";
import { decodeFrame, STREAM_IDS } from "./decode.ts";
import { ELOCK_RESP_ID, handleElockResponse, isElockResponse } from "./elock.ts";
import { frameArrival } from "./frame-arrival.ts";
import { GPS_CAN_ID } from "./gps.ts";
import { handleHubMirrorFrame } from "./hub-mirror.ts";
import { isObdResponse } from "./obd.ts";
import { resolvePackTemperatures } from "./pack-temperature.ts";
import { record } from "./signals.ts";
import { syncSystemClockFromGps } from "../gps/clock.ts";
import type { VcuReadRunner } from "../vcu/read-runner.ts";
import type { VcuWriteRunner } from "../vcu/write-runner.ts";

// Dispatch, clock and trust constraints: docs/development.md §Shared receive path constraints.
export function receiveCanFrame(message: CanMessage, context: ReceiveContext): void {
  const data = message.data;
  if (
    data.length === 8 &&
    (STREAM_IDS.includes(message.id) || isObdResponse(message.id) || isElockResponse(message.id))
  ) {
    context.noteTraffic();
  }
  if (isObdResponse(message.id)) {
    // Replay supplies no kernel arrival stamp; service latency must remain unknown.
    if (context.readRunner.handleCanFrame(message.id, data, frameArrival(message))) return;
    if (context.writeRunner.handleCanFrame(message.id, data)) return;
    context.obdResponse(message.id, data);
    return;
  }
  if (isElockResponse(message.id)) {
    handleElockResponse(data);
    return;
  }
  // Hub diagnostics and GPS share this multiplex: neither reader may consume the frame.
  if (message.id === GPS_CAN_ID) {
    handleHubMirrorFrame(data);
  }
  for (const { key, value } of resolvePackTemperatures(message.id, data, decodeFrame(message.id, data))) {
    record(key, value);
    if (key === "gps_epoch_s") {
      void syncSystemClockFromGps(value);
    }
  }
}

export interface ReceiveContext {
  readRunner: Pick<VcuReadRunner, "handleCanFrame">;
  writeRunner: Pick<VcuWriteRunner, "handleCanFrame">;
  obdResponse: (id: number, data: Buffer) => void;
  noteTraffic: () => void;
}

export const CAN_RX_FILTERS: RxFilter[] = [
  ...STREAM_IDS.map(id => ({ id, mask: 0x7ff })),
  { id: 0x7e0, mask: 0x7f0 },
  { id: ELOCK_RESP_ID, mask: 0x7ff },
];

export function matchesReceiveFilter(message: CanMessage): boolean {
  return !message.rtr && CAN_RX_FILTERS.some(filter => (message.id & filter.mask) === filter.id);
}
