import { POLL_MS, RECONNECT_DELAY_MS, SILENCE_LIMIT_MS, createConnection } from "../public/lib/connection.js";
import type { LinkStatus, SocketHandlers } from "../public/lib/connection.js";
import { connect, connection, isStale, serverTime, signalState } from "../public/lib/store.js";
import { viewRules } from "../public/lib/view-rules.js";
import { HEARTBEAT_MS, MAX_CLIENT_BACKLOG_BYTES, broadcastTo, dropStuckClients } from "../src/ws.ts";
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
// ## What this is guarding
//
// **The fast-forward.** The bike's phone is handlebar-mounted, so it spends much of a
// ride locked or behind another app, and iOS suspends this page for all of it. What was
// observed on this bike is that the socket survives that, the Pi keeps sending, and the
// backlog is delivered in a burst when the page wakes: about thirty seconds of the last
// few minutes replayed at speed, on tiles that look exactly like live telemetry. The
// fix is that there must be NO socket while the page is hidden — §1 is that rule and
// §2 is the anti-replay guard that goes with it, because closing a socket does not
// guarantee the frames already in flight are never delivered.
//
// **Recovery must not depend on a close event.** §3 drives the silence watchdog with a
// stand-in socket that NEVER fires `close` — that is the point of it. A socket can stop
// carrying data without closing (a hotspot dropping out mid-ride; iOS Safari is
// documented as reaching the same state with readyState still reading OPEN), and a
// reconnect path that only runs from `onclose` would sit there for ever.
//
// **And it must not churn.** The bike is often parked and silent, so §3 also pins the
// other end: nothing may happen at eleven point nine seconds. ws.ts heartbeats a full
// snapshot every 5 s whether or not the bus is saying anything, which is what makes
// silence a statement about the LINK and never about a quiet bike.
//
// **Nothing stale may be shown as live.** §5 holds the real isStale() from store.js up
// against the real connection states. This is the assertion worth the most: a frozen
// pack current at full brightness is worse than a visible dropout, because the rider
// has no cue that what they are reading is minutes old.
//
// §6 then runs the real connect() with the browser globals faked, because everything
// above it drives the policy directly and would stay green if the wiring that attaches
// it to `visibilitychange` were deleted. §7 is the Pi's half of the same question.
//
// **And nothing may move the screen because of it.** §8 is the other side of §5: making
// everything stale while the link is down is right for anything that DISPLAYS a value
// and wrong for the edge-triggered view rules, which read freshness as evidence about
// the bike. On a DC charge the contactor bit's freshness is the only evidence there is,
// so a dropout would otherwise throw the rider off the Charge tab and back — with a
// history entry each way, once per screen lock, at a charger.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** A socket that records what was done to it and, by default, never fires anything. */
interface FakeSocket {
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
        closed: false,
        handlers,
        close: () => {
          socket.closed = true;
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

  abandoned.handlers.opened(abandoned);
  check("a late handshake on an abandoned socket is closed rather than adopted", abandoned.closed);
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
  // The coupling that makes the number safe. ws.ts pushes a full snapshot every
  // HEARTBEAT_MS whether or not the bus has anything to say, so silence measures the
  // link; dropping SILENCE_LIMIT_MS below two heartbeats would make it measure jitter
  // instead and tear down healthy sockets on a bike that is merely parked.
  check(
    `${SILENCE_LIMIT_MS / 1000} s of silence is more than two ${HEARTBEAT_MS / 1000} s heartbeats`,
    SILENCE_LIMIT_MS > 2 * HEARTBEAT_MS
  );
}

// --- 4. An ordinary disconnect ----------------------------------------------
//
// `systemctl restart cool-eva`, or riding out of wifi range with a clean FIN behind it.
// The close event is honoured when it does arrive — it just makes recovery faster
// rather than possible — and the backoff that was there before this change is still
// the backoff.

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

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log(
    "✓ the socket is dropped when the page is, reopened when it comes back, and nothing stale is shown as live"
  );
}
