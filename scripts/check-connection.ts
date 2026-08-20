import { POLL_MS, RECONNECT_DELAY_MS, SILENCE_LIMIT_MS, createConnection } from "../public/lib/connection.js";
import type { LinkStatus, SocketHandlers } from "../public/lib/connection.js";
import { connect, connection, isStale, serverTime, signalState } from "../public/lib/store.js";
import { viewRules } from "../public/lib/view-rules.js";
import { createServer } from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import { randomBytes } from "crypto";
import { WebSocket as WsClient } from "ws";
import {
  HEARTBEAT_MS,
  MAX_CLIENT_BACKLOG_BYTES,
  MAX_CLIENT_FRAME_BYTES,
  broadcastTo,
  dropStuckClients,
  setupWs,
} from "../src/ws.ts";
import { SIGNALS } from "../src/can/registry.ts";
import type { LiveValue } from "../src/can/signals.ts";

// What the dashboard's WebSocket does when the phone stops looking at it.
//
//   node --experimental-strip-types scripts/check-connection.ts
//
// public/lib/connection.js is the policy — when a socket should exist and what to do
// when it should not — and it takes every effect it has on the world as a parameter,
// the way charge-mode.js takes `read` and `stale`. So the whole of it can be driven
// here against a stand-in socket, a fake clock and a fake `document.hidden`: no jsdom,
// no headless browser, no dependency, no bike.
//
// What each section holds:
//
//   §1–§2   no socket at all while the page is hidden, and no replay of frames already
//           in flight when it closes
//   §3      the silence watchdog, driven by a stand-in socket that NEVER fires `close`
//           — and the other end of it: nothing may happen at eleven point nine seconds
//   §4      the same fix with both directions of `visibilitychange` taken away
//   §5      nothing stale may be shown as live. The assertion worth the most here: a
//           frozen pack current at full brightness is worse than a visible dropout,
//           because the rider has no cue that what they read is minutes old
//   §6–§7   the real connect() with the browser globals faked, and the Pi's half
//   §8      …and nothing may MOVE THE SCREEN because of a dropout
//   §9–§10  ⚠️ the two that BIND EPHEMERAL LOOPBACK PORTS (127.0.0.1 only; no bike, no
//           can0), because "a client cannot kill the service" and "a service that
//           cannot bind does not pretend to be up" are the two claims here that a
//           stand-in cannot make
//
// The bugs each of those was written for: docs/diagnostics-and-checks.md §11.4.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/**
 * Runs a block that needs to observe uncaught exceptions, and guarantees it lets go
 * again — of the recorder and of every socket it opened.
 *
 * ⚠️ §9 and §10 install a PROCESS-WIDE net to catch a throw Node would otherwise turn
 * into a dead process, and while it is up it also catches failures in the CHECK. An
 * absorbed failure is worse than a loud one: the assertions stop half-made and the run
 * hangs on the sockets nobody closed until run-checks.ts kills it with "no verdict".
 * Two mutations landed exactly there before this existed. So a synchronous throw inside
 * `body` is reported as the failed assertion it is, and `cleanup` runs either way.
 *
 * @param section named in the failure, so a red run says which block gave up
 * @param body receives the exceptions seen so far and a place to register teardown
 */
async function watchingForCrashes(
  section: string,
  body: (uncaught: (Error & { code?: string })[], cleanup: (undo: () => void) => void) => Promise<void>
): Promise<void> {
  const uncaught: (Error & { code?: string })[] = [];
  const note = (error: Error) => uncaught.push(error);
  const teardown: (() => void)[] = [];
  process.on("uncaughtException", note);
  try {
    await body(uncaught, undo => teardown.push(undo));
  } catch (error) {
    check(
      `${section} threw partway through, so its later assertions were never made: ${(error as Error).message}`,
      false
    );
  } finally {
    process.off("uncaughtException", note);
    for (const undo of teardown.reverse()) {
      undo();
    }
  }
}

/** A socket that records what was done to it and, by default, never fires anything. */
interface FakeSocket {
  /**
   * How many times close() was called, not whether it was.
   *
   * A boolean cannot tell "this call closed it" from "it was already closed", and every
   * socket the policy abandons is closed by abandon() before anything else can touch
   * it — so a `closed` assertion about a LATER call is true before that call is made,
   * and passes whatever the call does. That shape shipped here once already.
   */
  closeCalls: number;
  closed: boolean;
  handlers: SocketHandlers;
  close: () => void;
}

/**
 * One dashboard's worth of connection policy, with the clock and the browser faked.
 *
 * `close()` deliberately does NOT call back into `closed()`. Every socket here is the
 * silent-death case unless a test explicitly delivers the event, which is what keeps
 * the checks honest about not depending on one.
 */
function newWorld() {
  const sockets: FakeSocket[] = [];
  const world = { hidden: false, now: 1_000, status: "connecting" as LinkStatus };

  const link = createConnection({
    hidden: () => world.hidden,
    now: () => world.now,
    report: status => {
      world.status = status;
    },
    open: handlers => {
      const socket: FakeSocket = {
        closeCalls: 0,
        closed: false,
        handlers,
        close: () => {
          socket.closed = true;
          socket.closeCalls += 1;
        },
      };
      sockets.push(socket);
      return socket;
    },
  });

  /** Steps the clock the way the real setInterval does — one tick every POLL_MS. */
  const advance = (ms: number) => {
    const steps = Math.round(ms / POLL_MS);
    for (let step = 0; step < steps; step += 1) {
      world.now += POLL_MS;
      link.tick();
    }
  };

  return {
    world,
    link,
    sockets,
    advance,
    open: () => sockets.filter(socket => !socket.closed),
    newest: () => sockets[sockets.length - 1],
    hide: () => {
      world.hidden = true;
      link.visibilityChanged();
    },
    show: () => {
      world.hidden = false;
      link.visibilityChanged();
    },
  };
}

// --- 1. Locking the phone, and unlocking it ----------------------------------

console.log("\n1. the screen goes off, and comes back");

{
  const phone = newWorld();
  phone.link.start();
  check("a socket is opened at startup", phone.sockets.length === 1);
  check("nothing is called live before a message arrives", phone.world.status === "connecting");

  phone.newest().handlers.opened(phone.newest());
  check("the handshake alone is still not live — the snapshot has not arrived", phone.world.status === "connecting");

  phone.newest().handlers.received(phone.newest());
  check("the first message is what makes it live", phone.world.status === "live");

  phone.hide();
  check("hiding the page closes the socket", phone.sockets[0].closed);
  check("...and the header stops claiming a link", phone.world.status === "offline");
  check("...and nothing new is opened in its place", phone.sockets.length === 1);

  // Five minutes in a pocket. On the real phone no timer runs here at all; ticking
  // anyway is the stricter test, and covers a desktop tab where they do.
  phone.advance(5 * 60_000);
  check("no socket is opened during five minutes hidden", phone.sockets.length === 1);
  check("the header still says nothing is arriving", phone.world.status === "offline");

  phone.show();
  check("unlocking opens exactly one new socket", phone.sockets.length === 2 && phone.open().length === 1);
  check("...immediately, with no reconnect delay in front of it", phone.world.status === "connecting");
  phone.newest().handlers.received(phone.newest());
  check("...and it is live as soon as the Pi's snapshot lands", phone.world.status === "live");
}

// --- 2. The backlog that arrives after the socket was dropped ----------------
//
// This is the one that decides whether the rider sees a fast-forward. Closing a socket
// does not guarantee the browser will never deliver frames that were already in flight,
// and iOS hands a resumed page its queued events in a burst. Those messages are, by
// construction, the recording — they must be refused, not applied.

console.log("\n2. what happens to the messages queued while it was hidden");

{
  const phone = newWorld();
  phone.link.start();
  const first = phone.newest();
  first.handlers.opened(first);
  first.handlers.received(first);

  phone.hide();
  check("a message from the dropped socket is refused", first.handlers.received(first) === false);
  check("...so it cannot relabel the header live", phone.world.status === "offline");

  phone.show();
  const second = phone.newest();
  check("a fresh socket is up", second !== first);
  check("the old socket's backlog is still refused", first.handlers.received(first) === false);
  check("...while the new socket's first message is taken", second.handlers.received(second) === true);
  check("...and only that one makes it live", phone.world.status === "live");
}

// --- 2b. Waking, locking and waking again -----------------------------------
//
// The stampede case. Every wake may cost at most one socket, and the events the
// abandoned ones fire afterwards — out of order, which on a resumed iOS page is normal
// rather than theoretical — may not cost another.

console.log("\n2b. lock, unlock, lock, unlock");

{
  const phone = newWorld();
  phone.link.start();
  const opened: number[] = [];

  for (let cycle = 0; cycle < 4; cycle += 1) {
    phone.hide();
    check(`cycle ${cycle}: nothing is left open while hidden`, phone.open().length === 0);
    phone.show();
    opened.push(phone.sockets.length);
    check(`cycle ${cycle}: exactly one socket is open`, phone.open().length === 1);
  }

  check("four wakes cost four sockets, not more", phone.sockets.length === 5);
  check(
    "each wake opened exactly one",
    opened.every((total, index) => total === index + 2)
  );

  // The late events. A resumed page delivers what it queued, and by then the decisions
  // about those sockets have already been taken.
  const abandoned = phone.sockets[1];
  const current = phone.newest();
  abandoned.handlers.closed(abandoned);
  check("a late close from an abandoned socket opens nothing", phone.sockets.length === 5);
  check("...and does not disturb the live one", phone.open().length === 1 && !current.closed);

  // closeCalls, not `closed`: abandon() closed this socket when it dropped it, so an
  // assertion on the boolean would have been true before this call and green whatever
  // the call did. What is being tested is that socketOpened() closes an orphan it is
  // handed rather than leaving it running.
  const closesBefore = abandoned.closeCalls;
  abandoned.handlers.opened(abandoned);
  check(
    "a late handshake on an abandoned socket is closed again rather than adopted",
    abandoned.closeCalls === closesBefore + 1
  );
  check("...and the current socket is still the current socket", !current.closed && phone.open().length === 1);

  // Long enough for a retry to have fired several times over, short of the silence
  // limit that would legitimately replace the socket that is up.
  phone.advance(3 * RECONNECT_DELAY_MS);
  check("no retry was ever queued for either of them", phone.sockets.length === 5);
}

// --- 3. OPEN, and carrying nothing ------------------------------------------
//
// The hotspot case, and the belt-and-braces one for any path into a dead-but-open
// socket that no visibility change announces. Note that no socket below ever fires a
// close event: recovery here is driven entirely by the absence of traffic.

console.log("\n3. a socket that stops carrying data without closing");

{
  const phone = newWorld();
  phone.link.start();
  const first = phone.newest();
  first.handlers.opened(first);
  first.handlers.received(first);

  phone.advance(SILENCE_LIMIT_MS - POLL_MS);
  check(
    `nothing happens at ${(SILENCE_LIMIT_MS - POLL_MS) / 1000} s — a parked bike must not churn sockets`,
    !first.closed && phone.world.status === "live" && phone.sockets.length === 1
  );

  phone.advance(2 * POLL_MS);
  check(`past ${SILENCE_LIMIT_MS / 1000} s of silence the socket is dropped`, first.closed);
  check("...and the header says so", phone.world.status === "offline");
  check("...without a close event ever being delivered", phone.sockets.length === 1);

  phone.advance(RECONNECT_DELAY_MS - POLL_MS);
  check("the retry waits out the backoff", phone.sockets.length === 1);
  phone.advance(2 * POLL_MS);
  check("...and then opens exactly one socket", phone.sockets.length === 2 && phone.open().length === 1);

  // A Pi that accepts the connection and then says nothing is the same fault one layer
  // in, and the budget has to start at the attempt or it would never be spent.
  const second = phone.newest();
  second.handlers.opened(second);
  phone.advance(SILENCE_LIMIT_MS + POLL_MS);
  check("a socket that connects and then says nothing is dropped too", second.closed);

  // And it keeps going rather than giving up or spinning.
  phone.advance(RECONNECT_DELAY_MS + POLL_MS);
  check("a third attempt follows", phone.sockets.length === 3);
  const before = phone.sockets.length;
  phone.advance(SILENCE_LIMIT_MS - POLL_MS);
  check("...and one attempt is one socket, not a spin", phone.sockets.length === before);
}

{
  // The handshake that NEVER completes — the bike is off, or the phone is out of range
  // and the SYN is going nowhere. No `open`, no `close`, no message: the only mark the
  // watchdog can measure from is the one openNow() takes at the attempt itself.
  //
  // Without that mark the socket is stuck with `lastTrafficAt === null`, which is a
  // conjunct of the silence branch — so the watchdog switches itself off and the header
  // sits on "connecting" for ever, on a phone whose rider is waiting for numbers.
  const phone = newWorld();
  phone.link.start();
  const attempt = phone.newest();
  check("the attempt is up, and unanswered", phone.sockets.length === 1 && !attempt.closed);

  phone.advance(SILENCE_LIMIT_MS - POLL_MS);
  check("nothing yet, at 11 s", !attempt.closed && phone.sockets.length === 1);

  phone.advance(2 * POLL_MS);
  check("a handshake that never completes is abandoned like any other silence", attempt.closed);
  check("...rather than sitting on 'connecting' for ever", phone.world.status === "offline");
  phone.advance(RECONNECT_DELAY_MS + POLL_MS);
  check("...and another attempt follows it", phone.sockets.length === 2);
}

{
  // The coupling that makes the number safe. ws.ts pushes a full snapshot every
  // HEARTBEAT_MS whether or not the bus has anything to say, so silence measures the
  // link; dropping SILENCE_LIMIT_MS below two heartbeats would make it measure jitter
  // instead and tear down healthy sockets on a bike that is merely parked.
  check(
    `${SILENCE_LIMIT_MS / 1000} s of silence is more than two ${HEARTBEAT_MS / 1000} s heartbeats`,
    SILENCE_LIMIT_MS > 2 * HEARTBEAT_MS
  );
}

// --- 4. An ordinary disconnect, and the events that go missing ---------------
//
// First `systemctl restart cool-eva`, or riding out of wifi range with a clean FIN
// behind it. The close event is honoured when it does arrive — it just makes recovery
// faster rather than possible — and the backoff that was there before this change is
// still the backoff.
//
// Then the same treatment applied to `visibilitychange` itself, in both directions,
// because a trigger with no second is a trigger that can be missed. The blocks below
// take the event away and require the fix to engage regardless: `pagehide` and a branch
// in tick() for the hidden direction, another branch in tick() for the visible one.

console.log("\n4. a socket that closes properly");

{
  const phone = newWorld();
  phone.link.start();
  const first = phone.newest();
  first.handlers.opened(first);
  first.handlers.received(first);

  first.handlers.closed(first);
  check("a close is reported as offline at once", phone.world.status === "offline");
  check("...and does not reconnect on the spot", phone.sockets.length === 1);

  phone.advance(RECONNECT_DELAY_MS - POLL_MS);
  check(`nothing before ${RECONNECT_DELAY_MS / 1000} s`, phone.sockets.length === 1);
  phone.advance(2 * POLL_MS);
  check("...one attempt after it", phone.sockets.length === 2);

  // Repeated failure: the bike is off and every attempt closes straight away. It must
  // keep trying at the same cadence, and never open two at once.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const socket = phone.newest();
    socket.handlers.closed(socket);
    check(`attempt ${attempt}: nothing is left open`, phone.open().length === 0);
    phone.advance(RECONNECT_DELAY_MS + POLL_MS);
    check(`attempt ${attempt}: exactly one new socket`, phone.open().length === 1);
  }
}

{
  // A close that arrives while the page is hidden must not queue a reconnect behind it.
  // On the real phone the retry would fire the moment iOS resumed the page — a socket
  // opened by a timer rather than by the rider looking at the screen.
  const phone = newWorld();
  phone.link.start();
  const first = phone.newest();
  phone.hide();
  first.handlers.closed(first);
  phone.advance(10 * RECONNECT_DELAY_MS);
  check("a close while hidden schedules nothing", phone.sockets.length === 1);
  phone.show();
  check("becoming visible is what reconnects", phone.sockets.length === 2);
}

{
  // The visibility event that never arrives, going the OTHER way — and this is the
  // direction that matters. A socket left open behind a hidden page is not silent, it
  // is filling up with exactly the backlog this whole change exists to prevent, so the
  // silence watchdog is no help: messages keep arriving and the header goes on saying
  // "live" over a page nobody is reading.
  const phone = newWorld();
  phone.link.start();
  const socket = phone.newest();
  socket.handlers.opened(socket);
  socket.handlers.received(socket);

  phone.world.hidden = true; // ...and no visibilityChanged() call to go with it
  phone.advance(POLL_MS);
  check("the poll drops a socket it finds on a hidden page", socket.closed);
  check("...and stops calling the link live", phone.world.status === "offline");

  // The backlog that was already on its way is refused, which is what makes the
  // recovery worth anything: catching it a second late must not mean applying a
  // second's worth of history.
  check("...and its queued messages are refused", socket.handlers.received(socket) === false);

  phone.advance(10 * SILENCE_LIMIT_MS);
  check("...and nothing is opened while it stays hidden", phone.sockets.length === 1);
  phone.show();
  check("...until it is looked at again", phone.sockets.length === 2);
}

{
  // `pagehide` — the same recovery for a platform that suspends the timers too, so the
  // branch above never gets to run. It fires on the way into the back/forward cache and
  // on the way out of the document, and in both cases `document.hidden` may still read
  // false, so it is deliberately unconditional.
  const phone = newWorld();
  phone.link.start();
  const socket = phone.newest();
  socket.handlers.opened(socket);
  socket.handlers.received(socket);

  phone.link.pageHidden();
  check("pagehide drops the socket without consulting document.hidden", socket.closed);
  check("...and says so", phone.world.status === "offline");
  check("...and refuses what was already in flight", socket.handlers.received(socket) === false);
  check("...and opens nothing behind it", phone.sockets.length === 1);
}

{
  // The visibility event that never arrives. Closing the socket on hide is what makes
  // this page eligible for Safari's back/forward cache, and a restore from it is
  // precisely where a visibility transition is least dependable — so `hidden` going
  // false with no event must still recover, on the poll that is running anyway.
  const phone = newWorld();
  phone.link.start();
  phone.hide();
  check("hidden, and nothing open", phone.open().length === 0);

  phone.world.hidden = false; // ...and no visibilityChanged() call to go with it
  phone.advance(POLL_MS);
  check("the poll opens one for a visible page that has none", phone.sockets.length === 2);
  phone.advance(5 * POLL_MS);
  check("...and exactly one, not one per tick", phone.sockets.length === 2);
}

{
  // Opened on a page that is already hidden — a home-screen icon tapped into a
  // background tab, or a reload while the screen is off.
  const phone = newWorld();
  phone.world.hidden = true;
  phone.link.start();
  check("start() on a hidden page opens nothing", phone.sockets.length === 0);
  check("...and says offline rather than connecting for ever", phone.world.status === "offline");
  phone.advance(10 * SILENCE_LIMIT_MS);
  check("...and still nothing, however long it waits", phone.sockets.length === 0);
  phone.show();
  check("...until it is looked at", phone.sockets.length === 1);
}

{
  // A `WebSocket` constructor that refuses the URL outright — mixed content, or a
  // SecurityError. Left to escape, that would be one uncaught error per POLL_MS for
  // ever, retrying ten times faster than every other failure path does.
  let refuse = true;
  const attempts: number[] = [];
  const world = { hidden: false, now: 1_000, status: "connecting" as LinkStatus };
  const link = createConnection({
    hidden: () => world.hidden,
    now: () => world.now,
    report: status => {
      world.status = status;
    },
    open: () => {
      attempts.push(world.now);
      if (refuse) {
        throw new DOMException("SecurityError", "SecurityError");
      }
      return { close: () => {} };
    },
  });

  let escaped: unknown = null;
  try {
    link.start();
  } catch (error) {
    escaped = error;
  }
  check("a constructor that throws does not take the caller down with it", escaped === null);
  check("...and the header says offline rather than connecting for ever", world.status === "offline");

  for (let step = 0; step < 6; step += 1) {
    world.now += POLL_MS;
    link.tick();
  }
  const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
  check(
    `...and it retries every ${RECONNECT_DELAY_MS / 1000} s rather than every poll`,
    gaps.length > 1 && gaps.every(gap => gap === RECONNECT_DELAY_MS)
  );
  refuse = false;
  world.now += RECONNECT_DELAY_MS;
  link.tick();
  check("...and connects when the constructor stops refusing", world.status === "connecting");
}

// --- 5. Nothing stale may be shown as live ----------------------------------
//
// The real isStale() from store.js, against the real connection states. Tiles grey
// themselves out on this answer (STALE_MS in lib/tiles.js), the charge rule is built on
// it (lib/charge-mode.js) and the faults headline turns "unknown" on it.
//
// The trap it is closing: isStale() compares a reading's timestamp against the SERVER
// clock of the last message, and that clock stops when the messages do. So without the
// link's own state in the answer, every age on the page freezes at whatever it was when
// the last message landed — a value sampled 200 ms before the phone was pocketed keeps
// reading 200 ms old for the whole five minutes it is in there, at full brightness.

console.log("\n5. what isStale() says while the link is down");

{
  const STALE_MS = 8000;
  const now = 1_800_000_000_000;
  const reading: LiveValue = { value: 12.3, unit: "A", group: "battery", ts: now - 200 };
  signalState("pack_a").val = reading;
  serverTime.val = now;

  connection.val = "live";
  check("a reading 200 ms old on a live link is not stale", isStale("pack_a", STALE_MS) === false);

  connection.val = "offline";
  check("the same reading is stale the moment the link is offline", isStale("pack_a", STALE_MS) === true);

  connection.val = "connecting";
  check("...and while reconnecting, before the new snapshot lands", isStale("pack_a", STALE_MS) === true);

  // Which is the whole point: the header and the numbers cannot disagree. Anything the
  // page shows at full brightness is something it is claiming arrived just now.
  connection.val = "live";
  signalState("pack_a").val = { ...reading, ts: now - STALE_MS - 1 };
  check("an old reading is stale on a live link too — unchanged", isStale("pack_a", STALE_MS) === true);

  check("a signal that has never arrived is stale", isStale("never_seen_signal", STALE_MS) === true);
  connection.val = "offline";
  check("...and still stale offline", isStale("never_seen_signal", STALE_MS) === true);
}

// --- 6. The same thing, wired up ---------------------------------------------
//
// Everything above drives the policy directly, which leaves the wiring in store.js's
// connect() unchecked — and that wiring is where the fix actually attaches to the
// browser. Deleting one `addEventListener` line there would undo the whole thing while
// §1 to §5 stayed green.
//
// So this runs the real connect() with the four browser globals it touches replaced by
// stand-ins. `setInterval` is one of them, which is the trick that makes it possible:
// the check owns the tick, so nothing is left running and no test has to sleep.
//
// It is also the only place the fast-forward is reproduced end to end — a message
// delivered on the socket AFTER the page was hidden, checked for having changed nothing
// on the screen.

console.log("\n6. the real connect(), with the browser faked");

{
  interface StubSocket {
    url: string;
    closed: boolean;
    onopen: null | (() => void);
    onmessage: null | ((event: { data: string }) => void);
    onerror: null | (() => void);
    onclose: null | (() => void);
    close: () => void;
  }

  const sockets: StubSocket[] = [];
  const timers: { delay: number; run: () => void }[] = [];
  const listeners = new Map<string, () => void>();
  const windowListeners = new Map<string, () => void>();
  const page = { hidden: false };

  // Captured so they can be put back at the end of the section. Left in place, a
  // stubbed `setInterval` that queues and never runs would follow every later section
  // around, and the failure mode of that is an assertion passing because nothing ever
  // ran — the worst kind of green.
  const replaced = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, value: unknown) => {
    if (!replaced.has(name)) {
      replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  const restoreGlobals = () => {
    for (const [name, descriptor] of replaced) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };

  define("document", {
    get hidden() {
      return page.hidden;
    },
    addEventListener: (type: string, handler: () => void) => listeners.set(type, handler),
  });
  define("location", { protocol: "http:", host: "cool-eva.local" });
  define("window", {
    addEventListener: (type: string, handler: () => void) => windowListeners.set(type, handler),
  });
  define("setInterval", (run: () => void, delay: number) => {
    timers.push({ delay, run });
    return timers.length;
  });
  define("WebSocket", function StubWebSocket(this: StubSocket, url: string) {
    this.url = url;
    this.closed = false;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    this.close = () => {
      this.closed = true;
    };
    sockets.push(this);
  });

  // try/finally, not a call at the end: an exception anywhere in here — store.js
  // throwing on a stub message, say — would otherwise leak the fakes into every
  // section after it, which is the exact failure the note above `replaced` names.
  try {
    const snapshotFor = (ts: number, value: number) =>
      JSON.stringify({ type: "snapshot", ts, signals: { soc: { value, unit: "%", group: "battery", ts } } });

    /** Through a call, so TypeScript cannot narrow the header to whatever it last read. */
    const header = (): LinkStatus => connection.val;

    const STALE_MS = 8000;
    const base = 1_800_000_000_000;

    connect();

    check(
      "connect() opens a socket at the page's own host",
      sockets.length === 1 && sockets[0].url === "ws://cool-eva.local"
    );
    check("...and registers a visibilitychange listener", listeners.has("visibilitychange"));
    check("...and a pagehide listener beside it", windowListeners.has("pagehide"));
    check(
      "...and a timer at the connection poll interval",
      timers.some(timer => timer.delay === POLL_MS)
    );

    const first = sockets[0];
    first.onopen?.();
    first.onmessage?.({ data: snapshotFor(base, 55) });
    check("a snapshot makes the header live", header() === "live");
    check("...and its reading arrives", signalState("soc").val?.value === 55);
    check("...shown as current", isStale("soc", STALE_MS) === false);

    // The phone goes in a pocket.
    page.hidden = true;
    listeners.get("visibilitychange")?.();
    check("hiding the page closes the real socket", first.closed);
    check("...and the header stops claiming a link", header() === "offline");
    check("...so the reading on screen is no longer shown as current", isStale("soc", STALE_MS) === true);

    // Five minutes later, the backlog. THIS is the fast-forward: without the guard in
    // connect(), every one of these lands, re-renders, and reads as live telemetry.
    first.onmessage?.({ data: snapshotFor(base + 60_000, 9) });
    check("a message queued on the hidden socket changes no value", signalState("soc").val?.value === 55);
    check("...and does not move the server clock", serverTime.val === base);
    check("...and cannot relabel the header live", header() === "offline");

    // The rider unlocks the phone.
    page.hidden = false;
    listeners.get("visibilitychange")?.();
    check("unlocking opens exactly one new socket", sockets.length === 2);
    check("...and nothing is called live until it has said something", header() === "connecting");
    check("...with the old values still not passing as current", isStale("soc", STALE_MS) === true);

    const second = sockets[1];
    second.onopen?.();
    second.onmessage?.({ data: snapshotFor(base + 300_000, 41) });
    check("the Pi's snapshot is what ends the gap", header() === "live" && signalState("soc").val?.value === 41);
    check("...and only then is a value current again", isStale("soc", STALE_MS) === false);

    // And the visibility event going missing entirely. Closing the socket on hide is what
    // makes this page eligible for the back/forward cache, and a restore from it is where
    // the visible transition is least dependable — so the poll has to be able to recover
    // on its own rather than waiting for an event that may never come.
    page.hidden = true;
    listeners.get("visibilitychange")?.();
    check("hidden again, nothing open", sockets.length === 2 && sockets[1].closed);
    page.hidden = false;
    check("...and no visibilitychange this time", sockets.length === 2);

    const poll = timers.find(timer => timer.delay === POLL_MS);
    poll?.run();
    check("the poll notices a visible page with no socket and opens one", sockets.length === 3);
    poll?.run();
    check("...exactly one, not one per tick", sockets.length === 3);

    // The hide direction losing its event, which is the half with nothing else under
    // it: a socket left open behind a hidden page goes on receiving, so the header
    // would keep reading "live" over a page nobody is looking at and the backlog would
    // build exactly as it does today.
    const third = sockets[2];
    third.onopen?.();
    third.onmessage?.({ data: snapshotFor(base + 600_000, 60) });
    check("a fresh socket is live again", header() === "live");

    page.hidden = true; // ...and no visibilitychange to say so
    poll?.run();
    check("the poll drops a socket it finds on a hidden page", third.closed);
    check("...and stops calling it live", header() === "offline");
    third.onmessage?.({ data: snapshotFor(base + 660_000, 3) });
    check("...and what was already in flight is refused", signalState("soc").val?.value === 60);

    // And pagehide, which is the recovery for a platform that suspends the poll too.
    page.hidden = false;
    poll?.run();
    const fourth = sockets[sockets.length - 1];
    fourth.onopen?.();
    fourth.onmessage?.({ data: snapshotFor(base + 700_000, 61) });
    check("back up after that drop", header() === "live" && !fourth.closed);
    windowListeners.get("pagehide")?.();
    check("pagehide drops the socket as well", fourth.closed);
    check("...and says so", header() === "offline");
  } finally {
    restoreGlobals();
  }
  check("the faked globals are put back", typeof globalThis.setInterval === "function" && !("document" in globalThis));
}

// --- 7. The server's half ---------------------------------------------------
//
// The client can only stop the Pi queueing at it if the client is well behaved. A phone
// that rides out of wifi range sends no FIN, and ws.ts would otherwise buffer every
// patch until TCP gave up minutes later — on a Pi Zero that is also sealing the ride
// log. MAX_CLIENT_BACKLOG_BYTES bounds it, and the size has to stay above one full
// snapshot or a client that recovers would be cut off from the very message that
// resynchronises it.

console.log("\n7. how far behind a client may fall before the Pi stops writing to it");

{
  const ts = 1_800_000_000_000;
  const signals: Record<string, LiveValue> = {};
  for (const signal of SIGNALS) {
    signals[signal.key] = { value: -123.45, unit: signal.unit, group: signal.group, ts };
  }
  const snapshotBytes = JSON.stringify({ type: "snapshot", ts, signals }).length;
  console.log(`     a full snapshot of ${SIGNALS.length} signals is ${snapshotBytes} bytes`);

  check(
    `the backlog cap (${MAX_CLIENT_BACKLOG_BYTES} bytes) holds several full snapshots`,
    MAX_CLIENT_BACKLOG_BYTES > 4 * snapshotBytes
  );

  // Measured over this bike's own ride log: 152 bytes a patch, 19-27 kB/s while riding
  // (p90-p99). The cap is stated in the source as "about ten seconds of riding", and
  // that has to keep being roughly true — a cap of a minute would not bound anything
  // worth bounding, and one of a second would drop patches on a healthy hotspot.
  const RIDING_BYTES_PER_SECOND = 26_718;
  const seconds = MAX_CLIENT_BACKLOG_BYTES / RIDING_BYTES_PER_SECOND;
  console.log(`     which is ${seconds.toFixed(1)} s of riding at the measured p99 rate`);
  check("the cap is worth at least five seconds of riding", seconds >= 5);
  check("...and less than the silence the dashboard already gives up after", seconds * 1000 < SILENCE_LIMIT_MS);
}

{
  // And that the cap is actually applied. broadcastTo() is the whole of the rule, so it
  // can be held up against stand-in clients: no server, no port, no sockets.
  const OPEN = 1;
  const CLOSING = 2;
  const sent: string[] = [];
  const hungUpOn: string[] = [];
  const client = (name: string, readyState: number, bufferedAmount: number) => ({
    name,
    readyState,
    bufferedAmount,
    send: () => {
      sent.push(name);
    },
    terminate: () => {
      hungUpOn.push(name);
    },
  });

  const clients = [
    client("keeping up", OPEN, 0),
    client("a little behind", OPEN, MAX_CLIENT_BACKLOG_BYTES),
    client("not reading", OPEN, MAX_CLIENT_BACKLOG_BYTES + 1),
    client("still connecting", CLOSING, 0),
  ];
  broadcastTo(clients, { type: "patch", ts: 1_800_000_000_000, signals: {} });

  check("a client that is keeping up is sent the patch", sent.includes("keeping up"));
  check("...and one a little behind still is", sent.includes("a little behind"));
  check("a client past the cap is skipped rather than queued at", !sent.includes("not reading"));
  check("a client that is not open is skipped", !sent.includes("still connecting"));
  check("...and nothing else was sent", sent.length === 2);

  // Skipping stops the queue growing; it never lets go of the ~256 kB already held, nor
  // of the slot in wss.clients. So a client still past the cap one heartbeat later gets
  // hung up on — but not one that was briefly over it and is draining.
  const stuck = new WeakSet<(typeof clients)[number]>();
  const stuckBytes = MAX_CLIENT_BACKLOG_BYTES + 1;
  const briefly = client("briefly behind", OPEN, stuckBytes);
  const gone = client("gone for good", OPEN, stuckBytes);
  // A destroyed socket reports nothing useful, which is the point of the last
  // assertion below: the byte count has to be taken before the terminate.
  gone.terminate = () => {
    hungUpOn.push("gone for good");
    gone.bufferedAmount = 0;
  };

  check(
    "nothing is hung up on the first time it is seen over the cap",
    dropStuckClients([briefly, gone], stuck).length === 0
  );
  briefly.bufferedAmount = 0;
  const dropped = dropStuckClients([briefly, gone], stuck);
  check("a client that drained is left alone", !hungUpOn.includes("briefly behind"));
  check("one still stuck a heartbeat later is hung up on", dropped.length === 1 && hungUpOn.includes("gone for good"));
  check("...reporting what it was holding, not what survived the destroy", dropped[0]?.bufferedAmount === stuckBytes);
  check("...and not again on the heartbeat straight after", dropStuckClients([gone], stuck).length === 0);
}

// --- 8. What the dropout does to the rules that choose the screen ------------
//
// isStale() reporting everything stale while the link is down is right for anything
// that DISPLAYS a value, and wrong for the one consumer that reads it as evidence about
// the bike: the edge-triggered view rules. On a DC fast charge the BMS reports Idle for
// the whole session, so `charging` rests entirely on the contactor bit's freshness —
// and a dropout takes that away without the bike having changed at all.
//
// Left to fire, the pair would move the rider off the Charge tab when the link went and
// back onto it when the link returned, pushing a history entry each way, once per screen
// lock, at a charger. That is the failure CONTACTOR_LIVE_MS's own comment says it exists
// to prevent, arriving by a different route.

console.log("\n8. the view rules across a dropout");

{
  const parked = { linkIsLive: true, charging: false, critical: false, heardFromBike: true };
  const dcCharging = { ...parked, charging: true };
  const memory = { honourUrlTab: false, wasCharging: false, wasCritical: false };

  check("plugging in moves to Charge", viewRules(memory, dcCharging, "ride").join() === "charge");
  check("...and stays there while it charges", viewRules(memory, dcCharging, "charge").length === 0);

  // The screen locks. Every signal is stale now, so charge-mode.js can only answer
  // "none" — the question is what the rules do with an answer they should not trust.
  const dropout = { ...parked, linkIsLive: false };
  check("a dropout moves nothing", viewRules(memory, dropout, "charge").length === 0);
  check("...however long it lasts", viewRules(memory, dropout, "charge").length === 0);
  check("...and the link coming back is not itself an event", viewRules(memory, dcCharging, "charge").length === 0);

  // The edge that IS real still fires, after all that.
  check("unplugging still takes you back to Ride", viewRules(memory, parked, "charge").join() === "ride");
}

{
  // The other half of the same guard. `critical` is value-based rather than
  // freshness-based, so a dropout does not move it — but the memory it is compared
  // against must be held all the same, or a link that blinks while the pack is already
  // under 5 % would come back looking like the pack having just fallen under 5 %.
  const memory = { honourUrlTab: false, wasCharging: false, wasCritical: true };
  const nearlyEmpty = { linkIsLive: true, charging: false, critical: true, heardFromBike: true };
  const dropout = { ...nearlyEmpty, linkIsLive: false, critical: false };

  check("a dropout with the pack already near empty moves nothing", viewRules(memory, dropout, "ride").length === 0);
  check("...and does not forget that it was", memory.wasCritical);
  check("...so the link returning is not a fall into hypermiling", viewRules(memory, nearlyEmpty, "ride").length === 0);
}

{
  // ...but only from the tab it moved you to. Unplugging while you are reading Faults
  // is not a reason to take Faults away from you.
  const memory = { honourUrlTab: false, wasCharging: true, wasCritical: false };
  const parked = { linkIsLive: true, charging: false, critical: false, heardFromBike: true };
  check("unplugging moves nothing if you had already moved away", viewRules(memory, parked, "faults").length === 0);
  check("...and the edge is still spent", !memory.wasCharging);
}

{
  // The deep-link pass, and that a dropout does not spend it. A link that named a tab
  // gets the first word; the bike gets every word after it.
  const memory = { honourUrlTab: true, wasCharging: false, wasCritical: false };
  const silent = { linkIsLive: false, charging: false, critical: false, heardFromBike: false };
  check(
    "a dropout before the bike has spoken does not spend the pass",
    viewRules(memory, silent, "faults").length === 0
  );
  check("...and the pass is still there", memory.honourUrlTab);

  const charging = { linkIsLive: true, charging: true, critical: false, heardFromBike: true };
  check(
    "the first readings are taken as state, not as a change into it",
    viewRules(memory, charging, "faults").length === 0
  );
  check("...and the pass is spent", !memory.honourUrlTab);
  check(
    "the next real edge moves the view again",
    viewRules(memory, { ...charging, charging: false }, "charge").join() === "ride"
  );
}

{
  // Both rules in one instant is two moves, as it was when they were two showTab()
  // calls in app.js: off the charger with the pack near empty.
  const memory = { honourUrlTab: false, wasCharging: true, wasCritical: false };
  const emptyAndUnplugged = { linkIsLive: true, charging: false, critical: true, heardFromBike: true };
  check(
    "leaving a charger near empty moves twice",
    viewRules(memory, emptyAndUnplugged, "charge").join() === "ride,hypermile"
  );
  check("...and neither fires again", viewRules(memory, emptyAndUnplugged, "hypermile").length === 0);
}

// --- 9. What a client on the bike's wifi can do to the service ---------------
//
// ⚠️ Binds an ephemeral port on 127.0.0.1 — no bike, no can0, nothing outside this
// machine — because "a hostile client cannot kill the process" is a claim no stand-in
// can make. `ws` reports a protocol violation by emitting `error` on the connection,
// and an EventEmitter with no `error` listener THROWS: uncaught, that is not a dropped
// client, it is the CAN reader, the ride-log sealing and every other dashboard.
//
// The cap and the listener are ONE change, so this section fires both halves and goes
// red for either on its own. docs/diagnostics-and-checks.md §10.3.

console.log("\n9. what a client on the bike's wifi can do to the service");

await watchingForCrashes("§9", async (uncaught, cleanup) => {
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 100));

  const server = createServer();
  cleanup(() => server.close());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const handle = setupWs(server);
  cleanup(() => handle.stop());

  const snapshotFrom = (client: WsClient) =>
    new Promise<string>((resolve, reject) => {
      client.once("message", data => resolve(String(data)));
      client.once("error", reject);
    });

  const hostile = new WsClient(`ws://127.0.0.1:${port}`);
  // terminate(), not close(): close() is a handshake the other end has to answer, so
  // server.close() would only complete when the assertions passed — a teardown that
  // works on the happy path alone is a check that hangs instead of failing.
  cleanup(() => hostile.terminate());
  const greeting = await snapshotFrom(hostile);
  check("a client is answered with a snapshot", JSON.parse(greeting).type === "snapshot");

  // The client end needs its own error listener for the same reason the server end does
  // — this process is an EventEmitter host too. Recorded, not discarded: the close code
  // it produces is the evidence that the cap did the rejecting.
  const clientErrors: Error[] = [];
  hostile.on("error", error => clientErrors.push(error));
  const closed = new Promise<number>(resolve => hostile.once("close", code => resolve(code)));

  // Raced against a deadline rather than simply awaited. A cap that is not there does
  // not reject anything, so the close would never come and this check would HANG —
  // run-checks.ts would eventually kill it, but "no verdict in two minutes" is a poor
  // way to say "the payload cap is gone". This way that mutation gets a clean ✗, and
  // the cap stops being the thing I could not pin.
  const NEVER_CLOSED = -1;
  hostile.send("x".repeat(MAX_CLIENT_FRAME_BYTES * 2));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const closeCode = await Promise.race([
    closed,
    new Promise<number>(resolve => {
      deadline = setTimeout(() => resolve(NEVER_CLOSED), 2000);
    }),
  ]);
  clearTimeout(deadline);
  console.log(
    closeCode === NEVER_CLOSED
      ? `     a ${MAX_CLIENT_FRAME_BYTES * 2}-byte frame was ACCEPTED — nothing closed within 2 s`
      : `     a ${MAX_CLIENT_FRAME_BYTES * 2}-byte frame closed that client with code ${closeCode}`
  );
  check("a frame over the cap gets the CLIENT closed", closeCode !== NEVER_CLOSED && closeCode !== 1000);
  await settle();
  check("...and the service is still standing", uncaught.length === 0);

  // Now one that needs no cap to be invalid, and killed the service on main before any
  // of this existed. Hand-rolled, because `ws` will not produce a malformed frame: the
  // handshake by hand, then FIN + RSV1 + text, masked, one byte of payload. RSV1 is only
  // legal under a negotiated extension and this handshake asks for none.
  const raw = net.connect(port, "127.0.0.1");
  cleanup(() => raw.destroy());
  const rawErrors: Error[] = [];
  raw.on("error", error => rawErrors.push(error));
  await new Promise<void>(resolve => raw.once("connect", () => resolve()));
  raw.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`
  );
  const handshake = await new Promise<string>(resolve => raw.once("data", data => resolve(String(data))));
  check("the hand-rolled handshake is accepted", handshake.startsWith("HTTP/1.1 101"));

  raw.write(Buffer.from([0xc1, 0x81, 0x00, 0x00, 0x00, 0x00, 0x41]));
  await settle();
  check("a malformed frame does not take the service down either", uncaught.length === 0);

  // The property all of that is in aid of: somebody else's bad frame must not cost the
  // rider their dashboard.
  const rider = new WsClient(`ws://127.0.0.1:${port}`);
  cleanup(() => rider.terminate());
  const afterwards = await snapshotFrom(rider);
  check("...and the next client is served exactly as before", JSON.parse(afterwards).type === "snapshot");

  check(
    uncaught.length === 0
      ? "nothing a client sent reached this process as an uncaught exception"
      : `a client killed the service: ${uncaught[0].message}`,
    uncaught.length === 0
  );
});

// --- 10. The server-level fault, which is not the one it looks like ---------
//
// ⚠️ The way in is NOT a handshake, which is why looking for one found nothing: ws
// 8.20.0 forwards the http server's own `error` straight to that emitter, and index.ts
// calls setupWs() before server.listen(), so EADDRINUSE arrives there. A listener that
// merely logs it leaves the process alive with nothing bound — dashboard dead, systemd
// told everything is fine.
//
// Both branches are pinned below, because the two failures are OPPOSITE: logging a bind
// failure is one regression, rethrowing an error that arrived after the bind is the
// other, and having no listener at all is the second by omission.
// docs/diagnostics-and-checks.md §10.3.

console.log("\n10. a server-level fault: fatal before the bind, survivable after it");

await watchingForCrashes("§10", async (uncaught, cleanup) => {
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 100));

  // After the bind: logged and survived. Provoked by emitting on the http server, which
  // is the same door the runtime uses — `ws` forwards it — rather than by reaching into
  // setupWs() for the WebSocketServer.
  const bound = createServer();
  cleanup(() => bound.close());
  await new Promise<void>(resolve => bound.listen(0, "127.0.0.1", () => resolve()));
  const boundPort = (bound.address() as AddressInfo).port;
  const boundHandle = setupWs(bound);
  cleanup(() => boundHandle.stop());

  bound.emit("error", new Error("provoked by check-connection.ts §10"));
  await settle();
  check("a server error arriving after the bind is survived", uncaught.length === 0);

  const client = new WsClient(`ws://127.0.0.1:${boundPort}`);
  cleanup(() => client.terminate());
  const greeting = await new Promise<string>((resolve, reject) => {
    client.once("message", data => resolve(String(data)));
    client.once("error", reject);
  });
  check("...and the dashboard is still served after it", JSON.parse(greeting).type === "snapshot");

  // Before the bind: fatal. A real EADDRINUSE against a port this process is already
  // holding — which is the restart race, one cool-eva still shutting down while the next
  // one comes up.
  const squatter = createServer();
  cleanup(() => squatter.close());
  await new Promise<void>(resolve => squatter.listen(0, "127.0.0.1", () => resolve()));
  const takenPort = (squatter.address() as AddressInfo).port;

  const doomed = createServer();
  cleanup(() => doomed.close());
  const doomedHandle = setupWs(doomed);
  cleanup(() => doomedHandle.stop());
  doomed.listen(takenPort, "127.0.0.1");
  await settle();

  check("a bind that fails is fatal rather than logged", uncaught.length === 1);
  check("...carrying the reason with it", uncaught[0]?.code === "EADDRINUSE");
  check("...and it is fatal precisely because nothing is bound", doomed.listening === false);
});

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log(
    "✓ the socket is dropped when the page is, reopened when it comes back, and nothing stale is shown as live"
  );
}
