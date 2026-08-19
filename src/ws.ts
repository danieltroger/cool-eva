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
 * readings), a patch is 152 bytes and riding produces 19–27 kB/s of them (p90–p99). It
 * is also six times the largest snapshot that could ever go out (38 kB with every
 * declared signal live, 20 kB of what this bike has actually produced), which is the
 * floor that matters — a cap under one snapshot would cut a recovering client off from
 * the very message that resynchronises it. scripts/check-connection.ts §7 keeps both
 * ends of that.
 *
 * Nothing is lost by dropping a patch, which is the property that makes this safe: the
 * heartbeat below re-sends the complete state every 5 s, so a client that falls behind
 * and catches up is fully correct one heartbeat later without any resend protocol.
 *
 * ⚠️ What this does NOT bound is a client that is slow rather than absent. A phone whose
 * downlink is merely slower than the patch rate keeps draining the queue, so its own
 * 12 s silence watchdog never fires and it never reconnects — and what it drains is old
 * telemetry that store.js applies as current. This cap holds that lag to roughly ten
 * seconds instead of the whole ride, which is worth having, but it is not a lag
 * detector and the dashboard has none of its own. Comparing `message.ts` deltas against
 * the phone's own monotonic deltas would be one — same clock on each side of both
 * subtractions, so it stays legal — and is the missing half of this.
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
 *
 * Skipping a stuck client stops the queue growing but never lets go of the ~256 kB it
 * is already holding, nor of its slot in `wss.clients`. The phone that rides out of
 * wifi range sends no FIN, so nothing else notices until the kernel gives up on the TCP
 * retransmits — on the order of fifteen minutes with the default `tcp_retries2`, once
 * per out-of-range event, on a Pi Zero that is also sealing the ride log.
 *
 * Two consecutive heartbeats rather than one reading, so a client that is briefly over
 * the cap is not hung up on for a spike. Be precise about what that does and does not
 * say, though: this samples two INSTANTS a heartbeat apart, not the interval between
 * them. A client over the cap at both is terminated however much it drained in between.
 *
 * That is the right call at the rates involved, which is why the coarse test is enough.
 * A client over the cap is sent nothing more (broadcastTo skips it), so its buffer only
 * drains; and the overshoot is at most one message, the largest of which is a full
 * snapshot at ~38 kB. So anything draining faster than ~7.6 kB/s — 38 kB across one
 * 5 s heartbeat — is back under the cap before the second sample is taken. A client
 * that cannot manage even that is moving at under half of what riding produces at its
 * QUIETEST (19 kB/s, p90), so it is not recovering from a spike, it is falling behind
 * for good.
 *
 * `alreadyStuck` is a WeakSet so a client that closes on its own takes its entry with
 * it.
 *
 * Terminate rather than close: close() is a handshake, and a peer that is not reading
 * is not going to answer one.
 *
 * @returns the clients hung up on and what each was holding, so the caller can say so
 * out loud. The byte count is taken BEFORE the terminate: `bufferedAmount` is the sum
 * of the socket's write buffer and the sender's, and destroying the socket has already
 * emptied the first half of that by the time the caller could read it.
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
 * The largest frame a client may send us.
 *
 * The receive-side mirror of MAX_CLIENT_BACKLOG_BYTES, and it can be this small because
 * **nothing here reads client messages at all** — there is no `on("message")` handler
 * anywhere in this file or below it, so every byte a client sends is already ignored.
 * What was not bounded is how many bytes `ws` would buffer up before ignoring them:
 * the default is 100 MB, on a Pi Zero, reachable by anyone on the same wifi as the
 * bike. 4 kB is generous room for whatever the first client→server message turns out
 * to be, and four orders of magnitude off the default.
 *
 * ⚠️ **This limit and the `error` listener below are one change, not two.** Rejecting a
 * frame is how `ws` reports a protocol violation, and it reports it by emitting `error`
 * on the connection — which Node turns into an uncaught exception, and therefore a dead
 * service, if nothing is listening. Setting a cap without the listener hands anyone on
 * the bike's wifi a way to kill the process with one 8 kB frame, taking ride-log sealing
 * down with it. Remove one and you must remove the other; scripts/check-connection.ts §9
 * fires both a rejected frame and a malformed one at a real server and requires it to
 * still be there afterwards.
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

  // The same hazard one layer out — but NOT for the reason it is tempting to assume.
  //
  // With `options.server`, ws 8.20.0 forwards the http server's own `error` straight to
  // this emitter: `addListeners(this._server, { …, error: this.emit.bind(this, "error"),
  // … })`, websocket-server.js:116-125. So what arrives here is not a failed handshake —
  // handshake faults are answered with an HTTP response and never reach an emitter — it
  // is whatever goes wrong with the listener itself. In practice, the bind failing.
  //
  // Which makes this listener's default answer the wrong one, and dangerously so: index.ts
  // calls setupWs() BEFORE server.listen(), so EADDRINUSE lands here, and merely logging it
  // leaves the process alive with nothing bound. systemd restarts a failed unit; it does
  // not restart a running one that happens to serve nothing. The dashboard would be dead
  // and everything that reports on it — the unit's state, the exit code — would say fine.
  //
  // So: not listening means not a service. Rethrown rather than exited, because an
  // uncaught exception prints the whole error and exits 1 — exactly what this did before
  // the listener existed — while process.exit() would abandon whatever stdio is still
  // queued, which on a journald pipe is the message saying why (see scripts/run-checks.ts).
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
