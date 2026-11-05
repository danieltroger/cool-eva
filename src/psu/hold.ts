import { monotonicNow } from "../monotonic.ts";
import { randomUUID } from "node:crypto";
import { busHeldBy, onBusAcquired } from "../vcu/bus-lease.ts";

export function createPsuHold(options: PsuHoldOptions): PsuHold {
  const context: HoldContext = {
    options,
    clock: options.clock ?? { now: monotonicNow, schedule: options.schedule ?? scheduleTimeout },
    on: false,
    revision: 0,
    instance: randomUUID(),
    generation: 0,
    deadline: 0,
    nextAttempt: 0,
    failures: 0,
    lastStopReason: null,
    transport: null,
    cancelTimer: null,
    closed: false,
  };
  const unsubscribe = onBusAcquired(() => stopHold(context, "bus-lease"));
  return {
    status: () => status(context),
    perform: (action, revision) => perform(context, action, revision),
    stop: reason => stopHold(context, reason),
    close: () => {
      context.closed = true;
      stopHold(context, "service-shutdown");
      unsubscribe();
    },
  };
}

export const PSU_HOLD_INTERVAL_MS = 150;
export const PSU_HOLD_MAX_MS = 60 * 60 * 1000;
export const PSU_TX_FAILURE_LIMIT = 3;

export type PsuHoldAction = "start" | "stop" | "extend";
export type PsuStopReason =
  | "owner"
  | "timeout"
  | "service-shutdown"
  | "can-down"
  | "bus-off"
  | "tx-errors"
  | "bus-lease"
  | "permission"
  | "setup-failed";

export interface PsuHoldStatus {
  instance: string;
  on: boolean;
  remainingMs: number;
  lastStopReason: PsuStopReason | null;
  revision: number;
  enabled: boolean;
  refusal: string | null;
}
export interface PsuTransport {
  send: () => number;
  close: () => void;
}
export interface PsuClock {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}
export interface PsuHoldOptions {
  enabled: () => boolean;
  canUnavailable: () => string | null;
  open: (fault: (reason: "can-down" | "bus-off") => void) => PsuTransport;
  clock?: PsuClock;
  schedule?: PsuClock["schedule"];
}
export interface PsuHoldResult {
  ok: boolean;
  statusCode: number;
  message: string;
  state: PsuHoldStatus;
}
export interface PsuHold {
  status: () => PsuHoldStatus;
  perform: (action: PsuHoldAction, revision: number) => PsuHoldResult;
  stop: (reason: PsuStopReason) => void;
  close: () => void;
}
interface HoldContext {
  instance: string;
  options: PsuHoldOptions;
  clock: PsuClock;
  on: boolean;
  revision: number;
  generation: number;
  deadline: number;
  nextAttempt: number;
  failures: number;
  lastStopReason: PsuStopReason | null;
  transport: PsuTransport | null;
  cancelTimer: (() => void) | null;
  closed: boolean;
}

function perform(context: HoldContext, action: PsuHoldAction, revision: number): PsuHoldResult {
  status(context);
  if (action === "stop") {
    stopHold(context, "owner");
    return result(context, 200, "PSU hold off; no new requests will be sent.");
  }
  if (revision !== context.revision) {
    return result(context, 409, "State changed. Read the current hold and confirm again.");
  }
  const refusal = startRefusal(context);
  if (refusal) {
    return result(context, context.options.enabled() ? 409 : 403, refusal);
  }
  if (action === "extend") {
    if (!context.on) {
      return result(context, 409, "The hold is off. Arm On to start a new hold.");
    }
    context.deadline = context.clock.now() + PSU_HOLD_MAX_MS;
    context.revision += 1;
    console.log("psu-hold: extended explicitly; auto-off in 60 minutes");
    return result(context, 200, "PSU hold extended to 60 minutes from now.");
  }
  if (context.on) {
    return result(context, 409, "PSU hold is already on. Arm Extend to renew it.");
  }
  const generation = ++context.generation;
  let setupFault: "can-down" | "bus-off" | null = null;
  try {
    context.transport = context.options.open(reason => {
      if (context.generation !== generation) return;
      if (context.on) {
        stopHold(context, reason);
      } else {
        setupFault = reason;
      }
    });
    if (setupFault || startRefusal(context)) {
      retireTransport(context);
      return result(context, 409, setupFault ?? startRefusal(context) ?? "CAN unavailable.");
    }
  } catch (error) {
    retireTransport(context);
    context.lastStopReason = "setup-failed";
    context.revision += 1;
    console.warn("psu-hold: start refused; CAN setup failed:", error);
    return result(context, 409, "PSU hold not started: CAN setup failed. Check the service log.");
  }
  context.on = true;
  context.revision += 1;
  context.failures = 0;
  context.deadline = context.clock.now() + PSU_HOLD_MAX_MS;
  context.nextAttempt = context.clock.now();
  console.log("psu-hold: started by owner; 150 ms repeat, 60 minute auto-off");
  sendStep(context, generation);
  return result(
    context,
    context.on ? 200 : 409,
    context.on ? "PSU hold on; auto-off in 60 minutes." : "PSU hold stopped during start."
  );
}

function sendStep(context: HoldContext, generation: number): void {
  if (!context.on || generation !== context.generation) return;
  context.cancelTimer = null;
  if (context.clock.now() >= context.deadline) {
    stopHold(context, "timeout");
    return;
  }
  if (!context.options.enabled()) {
    stopHold(context, "permission");
    return;
  }
  if (busHeldBy() !== null) {
    stopHold(context, "bus-lease");
    return;
  }
  if (context.options.canUnavailable() !== null) {
    stopHold(context, "can-down");
    return;
  }
  if (context.clock.now() < context.nextAttempt) {
    scheduleNext(context, generation);
    return;
  }
  try {
    // socketcan returns sizeof(can_frame), not its eight-byte payload DLC.
    if (context.transport?.send() !== 16) {
      context.failures += 1;
      console.warn(`psu-hold: TX failed (${context.failures}/${PSU_TX_FAILURE_LIMIT})`);
    } else {
      context.failures = 0;
    }
  } catch (error) {
    context.failures += 1;
    console.warn(`psu-hold: TX error (${context.failures}/${PSU_TX_FAILURE_LIMIT}):`, error);
  }
  if (!context.on || generation !== context.generation) return;
  if (context.failures >= PSU_TX_FAILURE_LIMIT) {
    stopHold(context, "tx-errors");
    return;
  }
  context.nextAttempt = context.clock.now() + PSU_HOLD_INTERVAL_MS;
  scheduleNext(context, generation);
}

function scheduleNext(context: HoldContext, generation: number): void {
  // A delayed callback skips missed slots; it never queues a catch-up burst.
  context.cancelTimer = context.clock.schedule(
    () => sendStep(context, generation),
    Math.max(0, Math.min(context.nextAttempt - context.clock.now(), context.deadline - context.clock.now()))
  );
}

function stopHold(context: HoldContext, reason: PsuStopReason): void {
  if (!context.on) return;
  context.on = false;
  context.generation += 1;
  context.revision += 1;
  context.deadline = 0;
  context.lastStopReason = reason;
  context.cancelTimer?.();
  context.cancelTimer = null;
  retireTransport(context);
  console.log(`psu-hold: stopped — ${reason}; no new requests`);
}

function retireTransport(context: HoldContext): void {
  const transport = context.transport;
  context.transport = null;
  if (!transport) return;
  try {
    transport.close();
  } catch (error) {
    console.warn("psu-hold: CAN channel cleanup failed:", error);
  }
}

function status(context: HoldContext): PsuHoldStatus {
  if (context.on && context.clock.now() >= context.deadline) {
    stopHold(context, "timeout");
  }
  return {
    instance: context.instance,
    on: context.on,
    remainingMs: context.on ? Math.max(0, context.deadline - context.clock.now()) : 0,
    lastStopReason: context.lastStopReason,
    revision: context.revision,
    enabled: context.options.enabled(),
    refusal: startRefusal(context),
  };
}

function startRefusal(context: HoldContext): string | null {
  if (context.closed) return "The service is shutting down.";
  if (!context.options.enabled()) return "Service writes are unavailable. Repair the settings/data fault first.";
  const holder = busHeldBy();
  if (holder !== null) return `Busy: ${holder}.`;
  return context.options.canUnavailable();
}

function result(context: HoldContext, statusCode: number, message: string): PsuHoldResult {
  return { ok: statusCode === 200, statusCode, message, state: status(context) };
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}
