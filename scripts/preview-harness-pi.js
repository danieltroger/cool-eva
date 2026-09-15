// The preview harness: the Raspberry Pi's doors, stubbed, for both preview pages.
//
// `fetch` and `WebSocket` — every endpoint the two pages have in common, and the socket that
// broadcasts the bike. What a write DOES is next door, in preview-harness-write.js. The contract and the injection order are in
// scripts/preview-harness.ts; the strings that may not appear here are in
// scripts/preview-harness-browser.js's header.
//
// ⚠️ previewFetch answers in one fixed order — shared routes, the generated tables, then the
// page's own pageFetch(), then the two rejections — and the comment beside the call says why
// that order is a contract rather than an accident.

// ── the Pi, stubbed ──────────────────────────────────────────────────────────

/**
 * A Response, near enough.
 *
 * ⚠️ It deep-copies, and that is load-bearing rather than tidiness. A real `json()`
 * parses the body afresh every time, so the dashboard gets a NEW object per response
 * — and VanJS only re-renders when a state is set to something `!==` what it held
 * (van-1.6.1.js's `set val`). Handing back the same mutated object left the sweep's
 * progress line advancing (it is also paced by a tick) while the button above it
 * stayed on "Stop the parameter read" forever, which would have looked like a bug in
 * the sheet and is not one.
 */
function json(body, status = 200) {
  const text = JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
  });
}

/** One WebSocket message, in the shape src/ws.ts broadcasts. */
function message(type, readings) {
  const at = Date.now();
  const signals = {};
  for (const [key, reading] of Object.entries(readings)) {
    signals[key] = { value: reading[0], unit: reading[1], group: reading[2], ts: reading[3] ?? at };
  }
  return { type, ts: at, signals };
}

window.fetch = function previewFetch(input, init) {
  const request = typeof input === "string" ? input : input && input.url ? input.url : String(input);
  const url = new URL(request, "http://eva.local/");
  const method = ((init && init.method) || "GET").toUpperCase();
  const path = url.pathname;

  if (path === "/status") {
    return json(STATUS);
  }
  if (path === "/waypoint") {
    STATUS.waypoints += 1;
    // The three signals go out too, because that is what the bike does: record()
    // writes them and ws.ts patches them to every client. Without this the preview
    // shows a permanently half-saved waypoint — the button's note claiming a save
    // the Waypoints tile above it has never been told about.
    // Stamped with the moment of the save and holding it, because that is the time the
    // Waypoints tile prints — the Pi's record() only touches these three when one is saved.
    const savedAt = Date.now();
    pushPatch({
      waypoint_seq: [STATUS.waypoints, "", "waypoint", savedAt],
      waypoint_lat: [51.4779, "°", "waypoint", savedAt],
      waypoint_lon: [-0.0015, "°", "waypoint", savedAt],
    });
    return json({
      saved: true,
      message: `Waypoint ${STATUS.waypoints} saved — 57.0000, 12.0000, 11 satellites.`,
    });
  }
  if (path === "/update") {
    // A FAILED pull, deliberately: it is the reply that exercises all three of the
    // note's claims at once — the newlines survive (white-space: pre-wrap), the long
    // URL wraps instead of widening the sheet (overflow-wrap: anywhere), and `ok:
    // false` paints it as a failure rather than in the same grey as a success.
    return json({
      ok: false,
      message:
        "Stopped after 60 s — bad wifi, or a remote that never answered.\n\n" +
        "remote: Enumerating objects: 41, done.\n" +
        "fatal: unable to access 'https://github.com/danieltroger/cool-eva.git/': " +
        "Failed to connect to github.com port 443 after 60000 ms: Couldn't connect to server",
    });
  }
  if (path === "/lifetime-read") {
    if (method !== "POST") {
      // GET /lifetime-stats serves the stored reading; this path only ever reads the bike.
      return json({ ...LIFETIME_READ, measurement: null, answered: null, message: "use POST" }, 405);
    }
    toast("Preview — nothing was sent. A Pi would have opened a diagnostic session on 51 and 52.");
    return json(LIFETIME_READ);
  }
  if (path === "/vcu-read") {
    if (method === "POST") {
      READ_STATE.run = {
        phase: "running",
        startedAt: Date.now(),
        finishedAt: null,
        complete: false,
        expected: 277,
        tally: {
          total: 277,
          read: 0,
          byStatus: {
            "read": 0,
            "refused": 0,
            "no-response": 0,
            "no-session": 0,
            "stalled": 0,
            "abandoned": 0,
            "unrecognised": 0,
            "not-sent": 0,
          },
          micros: [
            { micro: "A9", read: 0, failed: 0 },
            { micro: "A8", read: 0, failed: 0 },
          ],
        },
      };
      READ_STATE.message = "Started. Nothing here blocks — the sweep runs on the Pi.";
    } else if (method === "DELETE") {
      READ_STATE.run.phase = "finished";
      READ_STATE.run.complete = false;
      READ_STATE.message = "Stopped on request.";
    } else {
      stepSweep();
      READ_STATE.message = null;
    }
    return json(READ_STATE);
  }
  if (path === "/vcu-probe") {
    const index = Number(url.searchParams.get("index"));
    const target = TARGETS.find(candidate => candidate.index === index);
    if (!target) {
      return json({
        reading: {
          status: "read",
          // ⚠️ Narrowed to a real VcuTarget rather than echoed: searchParams.get() is
          // `string | null`, and the Pi's reply cannot name a micro it cannot address.
          target: url.searchParams.get("target") === "A8" ? "A8" : "A9",
          bank: Number(url.searchParams.get("bank")),
          index,
          identifier: (Number(url.searchParams.get("bank")) << 12) | index,
          rawHex: "01F4",
          unsigned: 500,
          signed: 500,
          value: null,
          name: null,
          // Null for the same reason `name` is: the name table describes bank 1 alone.
          section: null,
          note: "No name-table row describes this identifier, so only the bytes are known.",
        },
        message: null,
        gate: GATE,
        targets: [],
      });
    }
    return json({
      reading: {
        status: "read",
        target: target.micro,
        bank: 1,
        index: target.index,
        identifier: 0x1000 | target.index,
        rawHex: target.onBike.rawHex,
        unsigned: target.onBike.value,
        signed: target.onBike.value,
        value: target.onBike.value,
        name: target.name,
        section: "EVSE",
        note: null,
      },
      message: null,
      gate: GATE,
      targets: [],
    });
  }
  if (path === "/vcu-write") {
    if (method !== "POST") {
      return json({ status: writeStatus(url.searchParams), result: null, message: null });
    }
    const result = serviceWrite(url.searchParams);
    // The full-sheet panel renders the answer under the button, the way the bike would.
    // The close-ups below it do not — they are one block of the section — so the answer
    // is also said here, marked as the preview talking rather than the motorcycle.
    if (result) {
      const said = result.message.length > 150 ? `${result.message.slice(0, 147)}…` : result.message;
      toast(`Preview — nothing was sent. A Pi would have answered: ${said}`);
    }
    return json({
      status: writeStatus(url.searchParams),
      result,
      message: result ? null : "The preview does not carry that action.",
    });
  }
  // Tables, generated from the repo's own source at build time. Serving a
  // hand-written copy here would make the Faults tab call this bike's own
  // P0A07 "not in Energica's code table", which it plainly is.
  if (__TABLES[path]) {
    return json(__TABLES[path]);
  }
  // The page's own endpoints, after every shared one. The two previews answer a different
  // set — the whole dashboard serves the fan, the charge controller and the faults tab; the
  // annotated sheet serves a truthful 404 for the fan and nothing else — and this is the
  // seam. ⚠️ It runs AFTER the shared routes and the table fall-through and BEFORE the two
  // rejections below, which is the whole of the contract: a page cannot shadow a shared
  // route, and it cannot be reached by one. Kept as a call rather than a merged route table
  // because scripts/preview-endpoints.ts reads `path === "/x"` comparisons to decide which
  // endpoints a template answers, and a lookup object is invisible to it.
  const answer = pageFetch(url, method, path);
  if (answer) {
    return answer;
  }
  if (/^https?:/.test(request)) {
    // Deliberately NOT passed to the real fetch. This file is published as a
    // shareable artifact under a CSP that blocks external hosts, so a passthrough
    // is not "works when online" — it is a silent failure with no stub behind it.
    return json({ error: "preview: external requests are not made", url: request });
  }
  return Promise.reject(new Error(`preview: nothing serves ${path}`));
};

/**
 * Every socket the page is holding, so a stubbed action can patch them as the Pi would.
 *
 * ⚠️ A SET, because the annotated sheet holds six: it mounts one instance of the dashboard
 * per panel (see instantiate()), and each one connects. A single slot kept only the last,
 * so a waypoint saved in the first panel delivered its patch into the sixth panel's store.
 * The whole-dashboard page holds exactly one and behaves identically either way.
 */
const liveSockets = new Set();

/**
 * One patch to the page, in the shape src/ws.ts broadcasts.
 *
 * ⚠️ Written into LIVE first. Without that the next snapshot re-sent the fixture's own
 * constant over the top: tapping "Save waypoint here" moved the tile to #5 and the
 * reconnect a few seconds later put it back to #4, which is a preview undoing the one
 * thing the tester just did.
 */
function pushPatch(readings) {
  Object.assign(LIVE, readings);
  // Through deliver(), so a patch cannot reach a socket the page has already closed — the
  // guard the heartbeat below carries, which this used to go around.
  // One payload for every socket, the way src/ws.ts's broadcastTo() stringifies once and sends
  // the same body to each client — so the sheet's six panels cannot see six different `ts`.
  const payload = message("patch", readings);
  for (const socket of liveSockets) {
    socket.deliver(payload);
  }
}

/**
 * The Pi's end of the WebSocket: a snapshot on connect, and one every HEARTBEAT_MS after.
 *
 * ⚠️ The heartbeat is not decoration. It is what src/ws.ts does, and lib/connection.js declares
 * a link dead after SILENCE_LIMIT_MS of quiet — so a stub that sends one snapshot and stops has
 * the header flapping live → offline → live for ever, with every tile stale in between. What
 * that measured, and why it also keeps the DC scene mounted at all:
 * docs/diagnostics-and-checks.md §11.7.
 */
window.WebSocket = class PreviewWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    liveSockets.add(this);
    this.beat = setInterval(() => this.deliver(message("snapshot", LIVE)), SERVER.heartbeatMs);
    queueMicrotask(() => {
      if (this.onopen) {
        this.onopen();
      }
      this.deliver(message("snapshot", LIVE));
    });
  }
  deliver(payload) {
    if (this.readyState === 1 && this.onmessage) {
      this.onmessage({ data: JSON.stringify(payload) });
    }
  }
  send() {}
  close() {
    // A real socket's close event is asynchronous, and connection.js schedules the next
    // connection off it — firing it inside close() would reconnect from inside the teardown.
    clearInterval(this.beat);
    liveSockets.delete(this);
    this.readyState = 3;
    queueMicrotask(() => {
      if (this.onclose) {
        this.onclose();
      }
    });
  }
  addEventListener() {}
  removeEventListener() {}
};
