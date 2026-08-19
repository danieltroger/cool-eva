import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { snapshot, onChange, type LiveValue } from "./can/signals.ts";

// Event-driven push to the phone dashboard:
//   • full snapshot on connect
//   • a delta the instant a displayed value changes (per-signal deadbands already
//     rate-limit these, so there's nothing to throttle)
//   • a slow full-snapshot heartbeat purely for liveness (reconnect detection +
//     staleness) when the bike is sitting still and nothing is changing
//   • nothing at all to a client that has stopped reading — see
//     MAX_CLIENT_BACKLOG_BYTES, which is what keeps a suspended phone from being sent
//     a recording of the last five minutes when it wakes up
// Messages: { type: 'snapshot' | 'patch', ts, signals: { key: {value,unit,group,ts} } }
//
// The snapshot is also the whole of the resynchronisation protocol, and there is no
// other: a new connection is answered with one, and every 5 s heartbeat is another. So
// a client that misses patches — dropped here, or thrown away on its own side after a
// suspension — is completely correct again one heartbeat later, with nothing to replay
// and no per-client history for this server to keep.

export interface WsHandle {
  stop: () => void;
}

/**
 * The wire shape sent to the dashboard. The dashboard has no build step, but it does
 * import this: `public/lib/store.js` pulls it in through JSDoc, so `npm run typecheck`
 * fails if the two drift. (This comment used to say the opposite, and had been wrong
 * since checkJs was turned on over `public/**` in tsconfig.json.)
 */
export interface DashboardMessage {
  type: "snapshot" | "patch";
  ts: number;
  signals: Record<string, LiveValue>;
}

/**
 * How much unsent traffic one client may be behind by before we stop adding to it.
 *
 * A client that is not reading is not a client to keep writing to. iOS suspends the
 * dashboard whenever the screen locks or another app comes forward, and it does not
 * close the socket on the way — so without this the Pi queues every patch of however
 * long the phone spends in a pocket, and delivers all of it at once when the page wakes.
 * That is a fast-forward of old telemetry on the phone and an unbounded buffer here, on
 * a Pi Zero that is also sealing the ride log. `public/lib/connection.js` now closes the
 * socket before the page is suspended, which is the real fix; this is the half that does
 * not depend on the client being well-behaved, and it also covers a phone that walks out
 * of wifi range without ever sending a FIN.
 *
 * 256 kB is about ten seconds of riding: measured over this bike's own ride log (6.2 M
 * readings), a patch is 152 bytes and riding produces 19–27 kB/s of them (p90–p99).
 * Ten seconds is deliberately just inside the twelve the DASHBOARD gives a silent link
 * before it declares it dead and reconnects — so anything we would drop is destined for
 * a client that has already stopped believing in this socket. A working client on a
 * marginal hotspot never gets close: this is six times the largest snapshot that could
 * ever go out (38 kB with every declared signal live, 20 kB of what this bike has
 * actually produced), and scripts/check-connection.ts §7 keeps it that way.
 *
 * Nothing is lost by dropping a patch, which is the property that makes this safe: the
 * heartbeat below re-sends the complete state every 5 s, so a client that falls behind
 * and catches up is fully correct one heartbeat later without any resend protocol.
 */
export const MAX_CLIENT_BACKLOG_BYTES = 256 * 1024;

/**
 * How often the full snapshot goes out regardless of what the bus is doing.
 *
 * Named rather than inlined because the dashboard's silence watchdog is measured in
 * these: `public/lib/connection.js` gives a socket twelve seconds of nothing before it
 * declares it dead, which is only safe on a parked bike because a snapshot lands every
 * five whether or not a single CAN value has moved.
 */
export const HEARTBEAT_MS = 5000;

/** The part of a connected client this decision looks at, so it can be made without one. */
export interface BroadcastClient {
  readyState: number;
  bufferedAmount: number;
  send: (data: string) => void;
}

/**
 * Sends one message to every client that is in a state to receive it.
 *
 * A module-level function rather than the loop it used to be inside setupWs(), so the
 * rule about who gets skipped can be exercised against stand-in clients with no server,
 * no port and no sockets — scripts/check-connection.ts §7. It is one `if` and it decides
 * whether a phone coming out of a pocket gets current telemetry or a recording, which is
 * more than enough reason for it to be reachable by a check.
 */
export function broadcastTo(clients: Iterable<BroadcastClient>, message: DashboardMessage): void {
  const body = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > MAX_CLIENT_BACKLOG_BYTES) continue;
    client.send(body);
  }
}

export function setupWs(server: Server, heartbeatMs = HEARTBEAT_MS): WsHandle {
  const wss = new WebSocketServer({ server });

  const broadcast = (message: DashboardMessage): void => {
    if (wss.clients.size === 0) return;
    broadcastTo(wss.clients, message);
  };

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "snapshot", ts: Date.now(), signals: snapshot() }));
  });

  // Push only what changed, the moment it changes.
  onChange(changed => broadcast({ type: "patch", ts: Date.now(), signals: changed }));

  // Liveness heartbeat — NOT the update path.
  const timer = setInterval(() => broadcast({ type: "snapshot", ts: Date.now(), signals: snapshot() }), heartbeatMs);

  return {
    stop: () => {
      clearInterval(timer);
      wss.close();
    },
  };
}
