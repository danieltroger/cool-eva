import { createServer } from "http";
import type { AddressInfo } from "net";
import { createFanCommandQueue } from "../public/lib/fan-command-queue.js";
import type { FanCommand } from "../public/lib/fan-command-queue.js";
import type { FanAutomatic, FanAutoState, FanMode } from "../src/fan/auto.ts";
import type { FanCommandResult, FanController, FanState } from "../src/fan/control.ts";
import { MAX_DUTY_PERCENT, MIN_RUNNING_DUTY_PERCENT } from "../src/fan/control.ts";
import type { FanReply } from "../src/http/fan.ts";
import { FAN_HEADER, FAN_HEADER_VALUE, handleFanEndpoint, parseFanRequest } from "../src/http/fan.ts";
import { SERVICE_WRITE_HEADER, SERVICE_WRITE_HEADER_VALUE } from "../src/http/vcu-write.ts";

// The /fan wire, both ends of it, with no Pi and no phone.
//
//   node --experimental-strip-types scripts/check-fan-endpoint.ts
//
// ⚠️ THE HEADER IS A SECURITY GUARD AND IT HAD NO CHECK. This server sends no
// Access-Control-* headers and has no auth, so `<form method=POST action="http://
// cool-eva.local/fan?duty=100">` on any page the rider's phone opens on the hotspot is a
// SIMPLE request — no preflight, no header, and the fan spins. The custom header name is
// the whole mechanism: it makes the request non-simple, so the browser preflights it and
// this server never answers a preflight. Deleting the guard left the previous suite 18/18
// green, which is how a guard gets removed by accident.
//
// The other half is what the page SENDS: public/lib/fan-command-queue.js coalesces a drag
// into one POST in flight and one queued, which is the sort of thing that silently
// regresses to one POST per pixel.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

// --- 1. parseFanRequest(), pure ----------------------------------------------

console.log("\n1. what the query string is allowed to say");

function parse(query: string) {
  return parseFanRequest(new URLSearchParams(query));
}

const sixty = parse("duty=60");
check("duty=60 is a duty of 60", sixty.ok && sixty.kind === "duty" && sixty.duty === 60);
const stop = parse("duty=0");
check("duty=0 is a duty of 0 — a stop is a command, not a missing one", stop.ok && stop.kind === "duty");
check(`duty=${MAX_DUTY_PERCENT} is the cap and is allowed`, parse(`duty=${MAX_DUTY_PERCENT}`).ok);
check(`duty=${MAX_DUTY_PERCENT + 1} is not`, !parse(`duty=${MAX_DUTY_PERCENT + 1}`).ok);
const negative = parse("duty=-1");
check("a negative duty is not", !negative.ok);
check(
  `and the refusal says what the floor does, since ${MIN_RUNNING_DUTY_PERCENT - 1} % is a stop rather than a crawl`,
  !negative.ok && negative.reason.includes(String(MIN_RUNNING_DUTY_PERCENT))
);

check("a fractional duty is refused — one percent of a 50 000 ns period is 500 ns", !parse("duty=1.5").ok);
check("so is a word", !parse("duty=fast").ok);
check("so is Infinity, which Number() is happy to produce", !parse("duty=Infinity").ok);
check("so is NaN", !parse("duty=NaN").ok);
// Documented rather than fixed: both are whole numbers in range, so accepting them costs
// nothing. Written down so a future tightening reads as a choice and not as a bug fix.
const exponent = parse("duty=1e2");
check("⚠️  duty=1e2 IS accepted, as 100 — Number.isInteger() has no opinion on notation", exponent.ok);
const hex = parse("duty=0x40");
check("⚠️  and duty=0x40 as 64, for the same reason", hex.ok && hex.kind === "duty" && hex.duty === 64);

const auto = parse("mode=auto");
check("mode=auto is automatic", auto.ok && auto.kind === "mode" && auto.mode === "automatic");
const automatic = parse("mode=automatic");
check("…and so is mode=automatic, the long spelling", automatic.ok && automatic.kind === "mode");
const manual = parse("mode=MaNuAl");
check(
  "mode is case-insensitive and mode=manual is manual",
  manual.ok && manual.kind === "mode" && manual.mode === "manual"
);
check("surrounding whitespace is trimmed rather than refused", parse("mode=%20auto%20").ok);
check("an unknown mode is refused rather than guessed at", !parse("mode=off").ok);

check("⚠️  duty and mode together is a 400, not a guess about which was meant", !parse("mode=auto&duty=60").ok);
check("an empty query asks how much", !parse("").ok);
check("…and so does an empty duty", !parse("duty=").ok);
check("…and a whitespace-only one", !parse("duty=%20%20").ok);
// hasMode is a non-blank test, so a blank mode does not poison a perfectly good duty.
const blankMode = parse("mode=&duty=60");
check("a blank mode alongside a duty is still that duty", blankMode.ok && blankMode.kind === "duty");

// --- 2. The header, which is the only thing in front of the fan ---------------

console.log("\n2. the X-Cool-Eva header, against a real server on loopback");

// Widened on purpose: with the literal types tsc REFUSES the comparison as trivially
// true, which is the same fact this asserts — and the assertion is for the edit that
// makes it false, which tsc would then accept in silence.
const fanValue: string = FAN_HEADER_VALUE;
const serviceWriteValue: string = SERVICE_WRITE_HEADER_VALUE;
check(
  "⚠️  the fan's header VALUE is not the service-write one — a caller built for that cannot reach this",
  fanValue !== serviceWriteValue
);
check("…while the header NAME is shared, so both are the same non-simple request", FAN_HEADER === SERVICE_WRITE_HEADER);
// ⚠️ The name is held by the literal "X-COOL-EVA" below; the VALUE was held by nothing,
// because every request this file builds takes it from the server's own constant and so
// stays green for whatever that constant says. The other end does not: public/views/fan.js
// hard-codes `"X-Cool-Eva": "fan"` in its fetch and cannot see this file, so an edit here
// alone turns every POST the dashboard makes into a 403 — and the slider's failure path
// ("a request that did not come back may still have reached the Pi") tells the rider
// nothing about why. Both ends pinned to the literal is what keeps them agreeing.
check("the value is the literal `fan` public/views/fan.js hard-codes in its fetch", FAN_HEADER_VALUE === "fan");

/** What reached the automatic loop, so a refused request can be shown to have reached nothing. */
const commanded: string[] = [];

const fanState: FanState = { dutyPercent: 0, targetPercent: 0, driverEnabled: false, phase: "idle" };
const controller: FanController = {
  configured: true,
  fault: null,
  setDutyPercent: async percent => {
    commanded.push(`duty ${percent}`);
    return { ok: true, message: `commanded ${percent} %` };
  },
  state: () => fanState,
  stop: async () => {},
};

let currentMode: FanMode = "automatic";
const autoState: FanAutoState = { mode: currentMode, decision: null, temperatureAgeMs: 0 };
const automaticLoop: FanAutomatic = {
  mode: () => currentMode,
  setMode: async (next: FanMode): Promise<FanCommandResult> => {
    commanded.push(`mode ${next}`);
    currentMode = next;
    autoState.mode = next;
    return { ok: true, message: `now ${next}` };
  },
  commandManualDuty: async percent => {
    currentMode = "manual";
    autoState.mode = "manual";
    return await controller.setDutyPercent(percent);
  },
  state: () => autoState,
  stop: () => {},
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  void handleFanEndpoint(req, res, url, { controller, automatic: automaticLoop });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** One request, and how the endpoint answered it. */
async function post(query: string, headers: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`${base}/fan?${query}`, { method: "POST", headers });
  await response.text();
  return response.status;
}

const withHeader = { [FAN_HEADER]: FAN_HEADER_VALUE };

commanded.length = 0;
check("⚠️  a POST with NO header is refused with 403", (await post("duty=100")) === 403);
check("…and commanded nothing — this is the cross-origin form", commanded.length === 0);

commanded.length = 0;
check(
  "⚠️  a POST carrying the WRONG value is refused too, so the name alone is not the key",
  (await post("duty=100", { [FAN_HEADER]: "not-fan" })) === 403
);
check(
  "…including the service-write value, which is a caller aimed at the other endpoint",
  (await post("duty=100", { [FAN_HEADER]: SERVICE_WRITE_HEADER_VALUE })) === 403
);
check("…and an empty one", (await post("duty=100", { [FAN_HEADER]: "" })) === 403);
check("neither of them commanded anything", commanded.length === 0);

commanded.length = 0;
check("a POST carrying the header is accepted", (await post("duty=60", withHeader)) === 200);
check("…and that one really did reach the fan", commanded.length === 1 && commanded[0] === "duty 60");

commanded.length = 0;
check(
  "the header name is matched case-insensitively, because that is how it arrives off the wire",
  (await post("mode=auto", { "X-COOL-EVA": FAN_HEADER_VALUE })) === 200 && commanded.length === 1
);

commanded.length = 0;
check(
  "⚠️  a DUPLICATED header joins to `fan, fan` and fails closed rather than open",
  (await postDuplicateHeader()) === 403 && commanded.length === 0
);

commanded.length = 0;
check("a bad query WITH the header is a 400", (await post("duty=1.5", withHeader)) === 400);
check("…and commanded nothing either", commanded.length === 0);

const getResponse = await fetch(`${base}/fan`);
check("a GET needs no header — it touches no hardware", getResponse.status === 200);
const reply = (await getResponse.json()) as FanReply;
check(
  "…and reports the Pi's own limits, which is what stops the page keeping a second copy",
  reply.limits.minRunningPercent === MIN_RUNNING_DUTY_PERCENT && reply.limits.maxPercent === MAX_DUTY_PERCENT
);

const put = await fetch(`${base}/fan?duty=60`, { method: "PUT", headers: withHeader });
await put.text();
check(
  "anything other than GET or POST is a 405 that names both",
  put.status === 405 && put.headers.get("allow") === "GET, POST"
);

server.close();

// --- 3. The page's half of the wire: the coalescing queue --------------------
//
// public/lib/fan-command-queue.js, driven with a recording sender. A drag fires `input`
// about twenty times a second and every one of them calls queue(); what must reach the Pi
// is the first and then the latest per window, never one POST per event.

console.log("\n3. the slider's POSTs, coalesced");

const QUEUE_INTERVAL_MS = 60;

interface SenderLog {
  sent: FanCommand[];
  at: number[];
  concurrent: number;
  maxConcurrent: number;
  supersededAt: boolean[];
}

/** A sender that records what it was given, how many were in flight, and when. */
function recordingQueue(log: SenderLog, latencyMs: number, settling: boolean[], failFirst = false) {
  return createFanCommandQueue({
    intervalMs: QUEUE_INTERVAL_MS,
    onSettlingChange: pending => settling.push(pending),
    send: async (command, isSuperseded) => {
      log.sent.push(command);
      log.at.push(performance.now());
      log.concurrent += 1;
      log.maxConcurrent = Math.max(log.maxConcurrent, log.concurrent);
      await new Promise(resolve => setTimeout(resolve, latencyMs));
      log.supersededAt.push(isSuperseded());
      log.concurrent -= 1;
      if (failFirst && log.sent.length === 1) {
        throw new Error("the Pi went away mid-command");
      }
    },
  });
}

function emptyLog(): SenderLog {
  return { sent: [], at: [], concurrent: 0, maxConcurrent: 0, supersededAt: [] };
}

/** Long enough for every timer this queue can still have armed to have fired. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, QUEUE_INTERVAL_MS * 4));
}

/** One `input` event's worth of thumb movement. A real drag fires about every 50 ms. */
async function dragEvent(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 12));
}

const dragLog = emptyLog();
const dragSettling: boolean[] = [];
const dragQueue = recordingQueue(dragLog, 5, dragSettling);
const startedAt = performance.now();
dragQueue.queue({ duty: 30 });
check("a move raises settling at once, before anything is on the wire", dragSettling[0] === true);
await dragEvent();
check(
  "⚠️  the FIRST move goes at once — a slider that waited would feel broken",
  dragLog.sent.length === 1 && "duty" in dragLog.sent[0] && dragLog.sent[0].duty === 30
);
check("…and it went immediately, not one interval later", dragLog.at[0] - startedAt < QUEUE_INTERVAL_MS);

for (const duty of [40, 50, 60, 70]) {
  dragQueue.queue({ duty });
  await dragEvent();
}
await settle();
check(
  "⚠️  five moves are TWO POSTs, not five — the superseded ones never reach the network at all",
  dragLog.sent.length === 2
);
check(
  "⚠️  and the second is the LAST value, so the fan ends where the thumb left it",
  "duty" in dragLog.sent[1] && dragLog.sent[1].duty === 70
);
check("the two are at least one interval apart", dragLog.at[1] - dragLog.at[0] >= QUEUE_INTERVAL_MS - 1);
check("never more than one in flight", dragLog.maxConcurrent === 1);
check("settling is lowered again once nothing is queued or in flight", dragSettling.at(-1) === false);
check("…and the queue agrees it has gone quiet", !dragQueue.isSettling());

// A slow Pi: the send outlasts the interval, so a timer must NOT fire underneath it.
const slowLog = emptyLog();
const slowQueue = recordingQueue(slowLog, QUEUE_INTERVAL_MS * 2, []);
slowQueue.queue({ duty: 35 });
await new Promise(resolve => setTimeout(resolve, QUEUE_INTERVAL_MS / 2));
slowQueue.queue({ duty: 45 });
slowQueue.queue({ mode: "automatic" });
await settle();
await settle();
check("⚠️  a send slower than the interval still never overlaps the next one", slowLog.maxConcurrent === 1);
check(
  "⚠️  a mode tap inside a drag REPLACES the queued duty rather than merging with it — the queue holds one command of either kind",
  slowLog.sent.length === 2 && "mode" in slowLog.sent[1]
);
check(
  "⚠️  a send with something newer behind it is TOLD so, and its reply is not adopted over a moved thumb",
  slowLog.supersededAt[0] === true && slowLog.supersededAt[1] === false
);

// The failure the `finally` exists for: one POST that throws must not wedge the slider.
const brokenLog = emptyLog();
const brokenSettling: boolean[] = [];
const brokenQueue = recordingQueue(brokenLog, 5, brokenSettling, true);
brokenQueue.queue({ duty: 50 });
await settle();
brokenQueue.queue({ duty: 55 });
await settle();
check("⚠️  a send that THROWS does not wedge the queue — the next command still goes", brokenLog.sent.length === 2);
check(
  "…and settling is lowered rather than left raised for ever",
  brokenSettling.at(-1) === false && !brokenQueue.isSettling()
);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "s" : ""}`);
  process.exitCode = 1;
} else {
  console.log("✓ the header stands in front of every POST, the query string is parsed the way the docs say, and a");
  console.log("  twenty-event drag reaches the Pi as two commands with the last value intact");
}

/**
 * Two X-Cool-Eva headers on one request, which `fetch` will not build — Node joins
 * duplicates into `fan, fan`, and the point is that the comparison is exact so that
 * joining fails CLOSED rather than open.
 */
async function postDuplicateHeader(): Promise<number> {
  const response = await fetch(`${base}/fan?duty=100`, {
    method: "POST",
    headers: [
      [FAN_HEADER, FAN_HEADER_VALUE],
      [FAN_HEADER, FAN_HEADER_VALUE],
    ],
  });
  await response.text();
  return response.status;
}
