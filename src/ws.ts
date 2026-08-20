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
 * iOS suspends the dashboard when the screen locks without closing the socket, so
 * uncapped the Pi queues every patch of however long the phone spends in a pocket and
 * delivers all of it at once when the page wakes. 256 kB is ten seconds of riding and
 * six times the largest possible snapshot — a cap under one snapshot would cut a
 * recovering client off from the message that resynchronises it. check-connection.ts §7
 * keeps both ends; docs/diagnostics-and-checks.md §10.1 has the measurements.
 *
 * ⚠️ IT DOES NOT BOUND A CLIENT THAT IS SLOW RATHER THAN ABSENT: one whose downlink is
 * merely slower than the patch rate keeps draining the queue, so its 12 s silence
 * watchdog never fires and it never reconnects, while what it drains is old telemetry
 * store.js applies as current. Not a lag detector; the dashboard has none either.
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

/** The part of a connected client these decisions look at, so they can be made without one. */
export interface BroadcastClient {
  readyState: number;
  bufferedAmount: number;
  send: (data: string) => void;
  terminate: () => void;
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

/**
 * Hangs up on any client that was already past the cap at the previous heartbeat.
 * Skipping a stuck client stops the queue growing but never lets go of the ~256 kB it
 * already holds, nor of its slot in `wss.clients` — a phone that rides out of wifi range
 * sends no FIN, so nothing notices for the ~fifteen minutes the kernel spends on TCP
 * retransmits. Terminate, not close: close() is a handshake a dead peer will not answer.
 *
 * ⚠️ Two consecutive heartbeats, but be precise: it samples two INSTANTS a heartbeat
 * apart, not the interval between them, so a client over the cap at both is terminated
 * however much it drained in between. The doc's §10.2 has why that is right here.
 *
 * @returns the clients hung up on and what each held. ⚠️ The byte count is taken BEFORE
 * the terminate — `bufferedAmount` sums the socket's and the sender's write buffers, and
 * destroying the socket empties the first.
 */
export function dropStuckClients<Client extends BroadcastClient>(
  clients: Iterable<Client>,
  alreadyStuck: WeakSet<Client>
): { client: Client; bufferedAmount: number }[] {
  const dropped: { client: Client; bufferedAmount: number }[] = [];
  for (const client of clients) {
    if (client.bufferedAmount <= MAX_CLIENT_BACKLOG_BYTES) {
      alreadyStuck.delete(client);
      continue;
    }
    if (!alreadyStuck.has(client)) {
      alreadyStuck.add(client);
      continue;
    }
    alreadyStuck.delete(client);
    const bufferedAmount = client.bufferedAmount;
    client.terminate();
    dropped.push({ client, bufferedAmount });
  }
  return dropped;
}

/**
 * The largest frame a client may send us. It can be this small because **nothing here
 * reads client messages at all** — there is no `on("message")` handler in this file or
 * below it. What was not bounded is how many bytes `ws` would buffer before ignoring
 * them: the default is 100 MB, on a Pi Zero, reachable by anyone on the bike's wifi.
 *
 * ⚠️ **THIS LIMIT AND THE `error` LISTENER BELOW ARE ONE CHANGE, NOT TWO.** Rejecting a
 * frame is how `ws` reports a protocol violation, and it reports it by emitting `error`
 * on the connection — which Node turns into an uncaught exception, and therefore a dead
 * service, if nothing is listening. Setting a cap without the listener hands anyone on
 * the bike's wifi a way to kill the process with one 8 kB frame, taking ride-log sealing
 * down with it. Remove one and you must remove the other; scripts/check-connection.ts §9
 * fires both a rejected frame and a malformed one at a real server.
 */
export const MAX_CLIENT_FRAME_BYTES = 4 * 1024;

export function setupWs(server: Server, heartbeatMs = HEARTBEAT_MS): WsHandle {
  const wss = new WebSocketServer({ server, maxPayload: MAX_CLIENT_FRAME_BYTES });
  const stuck = new WeakSet<WebSocket>();

  const broadcast = (message: DashboardMessage): void => {
    if (wss.clients.size === 0) return;
    broadcastTo(wss.clients, message);
  };

  // A connection that fails at the protocol level — a frame over MAX_CLIENT_FRAME_BYTES,
  // a reserved bit set, a client frame arriving unmasked — is reported by `ws` as an
  // `error` event on that connection. An EventEmitter with no `error` listener THROWS,
  // and an uncaught throw here is the whole service: the CAN reader, the ride log, the
  // dashboards of anyone else connected. So this listener is not tidiness, it is the
  // difference between one bad frame being logged and one bad frame killing the bike's
  // telemetry. It was missing before the payload cap existed too — the cap is only what
  // made the easy trigger reachable.
  //
  // Logged rather than swallowed, per CLAUDE.md, and at `log` rather than `warn`: on a
  // machine anyone on the wifi can reach, a malformed frame is a thing that happens, and
  // the reason to record it is to know it happened at all.
  wss.on("connection", (ws: WebSocket) => {
    ws.on("error", (error: Error) => {
      console.log(`ws: dropping a client after a protocol error: ${error.message}`);
    });
    // Through the same path as everything else. This is the message a client's whole
    // recovery depends on, so it is not the one to send by a route nothing checks.
    broadcastTo([ws], { type: "snapshot", ts: Date.now(), signals: snapshot() });
  });

  // ⚠️ The same hazard one layer out — but NOT for the reason it is tempting to assume.
  // With `options.server`, ws 8.20.0 forwards the http server's own `error` straight to
  // this emitter (websocket-server.js:116-125), so what arrives is NOT a failed
  // handshake: it is whatever goes wrong with the listener itself, in practice the bind
  // failing. index.ts calls setupWs() BEFORE server.listen(), so EADDRINUSE lands here,
  // and merely logging it leaves the process alive with nothing bound — systemd restarts
  // a failed unit, not a running one that serves nothing, so the dashboard would be dead
  // and every report on it would say fine. Not listening means not a service.
  //
  // Rethrown rather than exited: an uncaught exception prints the whole error and exits
  // 1, while process.exit() would abandon whatever stdio is still queued, which on a
  // journald pipe is the message saying why. docs/diagnostics-and-checks.md §10.3.
  wss.on("error", (error: Error) => {
    if (!server.listening) {
      throw error;
    }
    console.log(`ws: server error after binding, carrying on: ${error.message}`);
  });

  // Push only what changed, the moment it changes.
  onChange(changed => broadcast({ type: "patch", ts: Date.now(), signals: changed }));

  // Liveness heartbeat — NOT the update path. Also the beat the stuck-client check runs
  // on, since "still stuck one heartbeat later" is what it means by stuck.
  const timer = setInterval(() => {
    for (const { bufferedAmount } of dropStuckClients(wss.clients, stuck)) {
      console.log(`ws: hung up on a client holding ${bufferedAmount} unsent bytes across two heartbeats`);
    }
    broadcast({ type: "snapshot", ts: Date.now(), signals: snapshot() });
  }, heartbeatMs);

  return {
    stop: () => {
      clearInterval(timer);
      wss.close();
    },
  };
}
