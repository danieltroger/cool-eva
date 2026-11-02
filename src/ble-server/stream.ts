import { onChange, snapshot, type LiveValue } from "../can/signals.ts";
import { HEARTBEAT_MS, type DashboardMessage } from "../ws.ts";

// The live telemetry over BLE: the same DashboardMessage snapshots and patches ws.ts
// sends, with two differences the radio forces. Patches are coalesced per window rather
// than sent per change, because a 20 Hz signal sealed one message at a time spends more
// on framing and GCM tags than on data. And a backlog sheds patches at a far smaller cap
// than MAX_CLIENT_BACKLOG_BYTES, because 256 kB is ten seconds of riding over wifi and
// more like ten seconds of *queue* here. The heartbeat snapshot is the resync either way.

/** Coalescing window. Under the dashboard's 2 Hz chart tick, so nothing visible is lost. */
export const PATCH_WINDOW_MS = 100;

/**
 * Past this many queued bytes, patches are dropped until the queue drains. Snapshots are
 * still sent, since one is what makes a client that missed patches correct again.
 */
export const MAX_BLE_BACKLOG_BYTES = 16 * 1024;

export interface StreamContext {
  send: (message: DashboardMessage) => void;
  bufferedBytes: () => number;
}

export interface TelemetryStream {
  stop: () => void;
}

export function startTelemetryStream(context: StreamContext, heartbeatMs = HEARTBEAT_MS): TelemetryStream {
  let pending: Record<string, LiveValue> = {};
  let pendingCount = 0;

  context.send({ type: "snapshot", ts: Date.now(), signals: snapshot() });

  const unsubscribe = onChange(changed => {
    for (const [key, value] of Object.entries(changed)) {
      pending[key] = value;
      pendingCount++;
    }
  });

  const patchTimer = setInterval(() => {
    if (pendingCount === 0) return;
    const signals = pending;
    pending = {};
    pendingCount = 0;
    if (context.bufferedBytes() > MAX_BLE_BACKLOG_BYTES) return;
    context.send({ type: "patch", ts: Date.now(), signals });
  }, PATCH_WINDOW_MS);

  const heartbeatTimer = setInterval(() => {
    context.send({ type: "snapshot", ts: Date.now(), signals: snapshot() });
  }, heartbeatMs);

  return {
    stop: () => {
      unsubscribe();
      clearInterval(patchTimer);
      clearInterval(heartbeatTimer);
    },
  };
}
