import { createServer } from "http";
import type { AddressInfo } from "net";
import type { IncomingMessage } from "http";
import { readFile, readdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CAN_RESTART_HEADER, CAN_RESTART_HEADER_VALUE, handleCanRestartEndpoint } from "../src/http/can-restart.ts";
import { UPDATE_HEADER, UPDATE_HEADER_VALUE, handleUpdateEndpoint } from "../src/http/update.ts";
import { recordingResponse, postRequest } from "./recording-response.ts";
import { declarationBody, withoutCommentLines } from "./source-blocks.ts";

// The header that stands in front of /update and /can-restart — the menu sheet's two
// Pi-maintenance actions, which had no guard at all until #150.
//
//   node --experimental-strip-types scripts/check-endpoint-headers.ts
//
// ⚠️ It is a CSRF barrier, NOT authentication, and nothing here should be read as
// asserting otherwise. What it stops is the cross-origin `<form method="POST">`, which
// cannot set a header, and cross-origin `fetch`, which must preflight a custom header
// name and this server answers no preflight. It stops nobody with a `curl` and the
// bike's wifi password. docs/wifi-hardening.md says so next to the route table.
//
// ⚠️ /update IS NEVER GIVEN A REAL SERVER HERE. It arms `sudo systemctl restart cool-eva`
// on the response's "finish" event, so §3 uses ./recording-response.ts and aims the
// handler at a directory that is not a repo — a pull cannot succeed, so a restart cannot
// be armed, even on a build whose guard has been deleted.
//
// ⚠️ /can-restart DOES get a real server, on a loopback port, with an interface name no
// machine has. A refused request answers 403; one that got past the guard reaches
// restartCanLink() and comes back 500 `Restart failed: …`, which only that catch writes.
// That pair is the evidence the guard returns BEFORE the `ip link` commands — and `can0`
// is untouched on macOS (no `ip` at all), on CI and on the Pi. README's "no bike, no
// can0, no capture" is a promise this check keeps.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** An interface name no machine has, so the accepted path fails before it can reconfigure one. */
const NO_SUCH_IFACE = "cool-eva-check0";

// --- 1. the constants, and that no two endpoints share a value ---------------

console.log("\n1. the header name, shared; the values, not");

check(`/update's header name is the shared one`, UPDATE_HEADER === "x-cool-eva");
check(`…and /can-restart's is too, so both are the same non-simple request`, CAN_RESTART_HEADER === "x-cool-eva");

// ⚠️ Pinned to the LITERAL the dashboard hard-codes, not compared with itself. Every request
// this file builds takes the value from the server's own constant and so stays green for
// whatever that constant says; public/views/pi-actions.js cannot see this file and hard-codes
// its own string. Both ends pinned to the same literal is what keeps them agreeing — the
// lesson scripts/check-fan-endpoint.ts wrote down after the same trap.
check("/update's value is the literal `update`", UPDATE_HEADER_VALUE === "update");
check("/can-restart's value is the literal `can-restart`", CAN_RESTART_HEADER_VALUE === "can-restart");

const headerValues = await exportedHeaderValues();
console.log(`   values in src/http/: ${headerValues.map(entry => `${entry.file}=${entry.value}`).join(", ")}`);
// ⚠️ A floor, because a regex that matches nothing passes the assertion below in silence —
// the same guard check-arming.ts puts on its own scans (`literalKeys.length >= 2`). Six today:
// fan, vcu-write, vcu-read, charge-auto, and this PR's two.
check("the header-value constants were found at all", headerValues.length >= 6);
check(
  `⚠️  no two of the ${headerValues.length} DECLARATIONS share a value — a caller built for one endpoint cannot ` +
    "reach another that declares its own",
  new Set(headerValues.map(entry => entry.value)).size === headerValues.length
);
// ⚠️ DECLARATIONS, and the noun is the whole of it. Three ROUTES answer to `service-mode`:
// /vcu-read declares it, and /lifetime-read and /vcu-probe import that same constant deliberately
// — one service session, three ways in. This scan sees declaration SITES, so it is blind to
// sharing-by-import and must not be read as "no two routes share". docs/wifi-hardening.md's route
// table is where that is written down truthfully.

// ⚠️ THE OTHER HALF OF THE BARRIER, and until #240 it was claimed in four places and held in
// none. The header comparison stops the cross-origin `<form>`, which cannot set a header. What
// stops a cross-origin `fetch` — which can — is that a custom header name makes the request
// non-simple, so the browser sends an OPTIONS preflight first and THIS SERVER NEVER ANSWERS ONE.
// Add an OPTIONS branch with `Access-Control-Allow-Headers: X-Cool-Eva` to src/index.ts and every
// guard in the table above is defeated at once — /fan and /vcu-write with them — while every
// other assertion in this file still passes. Read off the routing rather than argued about.
const routing = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
check(
  "src/index.ts was read at all — an empty string would pass the one below in silence",
  routing.includes("createServer(")
);
// ⚠️ The test is "no CORS header is ever WRITTEN", not "the token OPTIONS never appears". A
// preflight succeeds only if the reply carries Access-Control-Allow-Origin and -Allow-Headers, so
// an explicit `OPTIONS → 405` would be a STRONGER refusal than having no branch at all — a check
// that banned the word would forbid the better implementation. Comment lines go first for the same
// reason: fan.ts and can-restart.ts explain this in prose, and the file where that sentence belongs
// most must not be the one file it cannot be written in. Handlers are scanned too — the property is
// about every reply this server sends, and src/index.ts is not the only place one is written.
const corsWriters = [["src/index.ts", routing] as const, ...(await httpSources())].filter(([, source]) =>
  withoutCommentLines(source).includes("Access-Control-")
);
check(
  "⚠️  …and no CORS header is written in the routing or in any handler — the half of the barrier " +
    "that stops a cross-origin fetch, whose preflight this server never answers",
  corsWriters.length === 0
);

// --- 2. /can-restart, against a real server on loopback -----------------------

console.log("\n2. /can-restart: what a page on the bike's wifi can do to the bus");

const server = createServer((req, res) => {
  void handleCanRestartEndpoint(req, res, NO_SUCH_IFACE);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  // ⚠️ The reply is evidence about the REPLY. What §2 is really about is the ORDERING — that the
  // guard returns before the two `ip link` commands — so the call is observed rather than inferred:
  // handleCanRestartEndpoint's catch warns with the interface it failed on, and a refused request
  // must produce no such line. A guard moved BELOW restartCanLink still answers 403 with no
  // `Restart failed` in the body, and would pass the two assertions either side of this one while
  // every header-less POST on the bike's wifi really did re-up can0.
  const refused = await withWarningsRecorded(() => post("/can-restart"));
  check("⚠️  a POST with NO header is refused with 403 — this is the cross-origin form", refused.result.status === 403);
  check(
    "⚠️  …and restartCanLink was never CALLED — the endpoint's own failure warning never printed, " +
      "which is the ordering rather than the answer",
    refused.warnings.length === 0
  );
  check("…and the refusal names the header it wanted", refused.result.body.includes(CAN_RESTART_HEADER));

  const wrongValue = await post("/can-restart", { [CAN_RESTART_HEADER]: "not-it" });
  check("a POST carrying the WRONG value is refused too, so the name alone is not the key", wrongValue.status === 403);

  // Off the scrape, not off an import: `import { FAN_HEADER_VALUE } from "../src/http/fan.ts"`
  // drags the fan controller, the PWM driver and the encrypted log — crypto and zlib with them —
  // into this process to read five characters, and §1 already has the value on disk.
  const fanHeaderValue = headerValues.find(entry => entry.file === "fan")?.value ?? "";
  check("the fan's value was scraped at all, so the refusal below is of a real value", fanHeaderValue === "fan");
  const fanValue = await post("/can-restart", { [CAN_RESTART_HEADER]: fanHeaderValue });
  check("…including the fan's value, which is a caller aimed at another endpoint", fanValue.status === 403);

  const updateValue = await post("/can-restart", { [CAN_RESTART_HEADER]: UPDATE_HEADER_VALUE });
  check(
    "⚠️  …and /update's, which is the neighbour on the same sheet and the likeliest wrong constant",
    updateValue.status === 403
  );

  const empty = await post("/can-restart", { [CAN_RESTART_HEADER]: "" });
  check("…and an empty one", empty.status === 403);

  const duplicated = await postDuplicateHeader();
  check(
    "⚠️  a DUPLICATED header joins to `can-restart, can-restart` and fails CLOSED rather than open",
    duplicated.status === 403
  );

  const accepted = await withWarningsRecorded(() =>
    post("/can-restart", { [CAN_RESTART_HEADER]: CAN_RESTART_HEADER_VALUE })
  );
  check(
    "⚠️  a POST carrying the header gets past the guard and reaches restartCanLink — 500 against " +
      `an interface no machine has, which is how this check can prove that without touching can0`,
    accepted.result.status === 500 && accepted.result.body.includes("Restart failed")
  );
  check(
    "…and THAT one did warn, naming the interface — so the silence asserted above is the guard " +
      "refusing and not a spy that records nothing",
    accepted.warnings.length === 1 && accepted.warnings[0].includes(NO_SUCH_IFACE)
  );

  const upperCase = await post("/can-restart", { "X-COOL-EVA": CAN_RESTART_HEADER_VALUE });
  check(
    "the header name is matched case-insensitively, because that is how it arrives off the wire",
    upperCase.status === 500
  );

  const got = await fetch(`${base}/can-restart`);
  await got.text();
  check(
    "a GET is still a 405 that names what to use — the method guard runs before the header one, " +
      "so a GET is never told about a header it was never going to need",
    got.status === 405 && got.headers.get("allow") === "POST"
  );
} finally {
  server.close();
}

// --- 3. /update, on the recorder that never emits "finish" --------------------

console.log("\n3. /update: the same door, in front of a sudo git pull and a restart");

// Not a repo, so even a build with the guard deleted cannot complete a pull — and it is
// the SUCCESS path that arms the restart. Nothing here can reach `systemctl`.
const notARepo = await mkdtemp(join(tmpdir(), "cool-eva-headers-check-"));
try {
  const noHeader = recordingResponse();
  await handleUpdateEndpoint(postRequest(), noHeader.res, notARepo);
  check("⚠️  a POST with NO header is refused with 403", noHeader.statusCode === 403);
  check("…and armed no restart", noHeader.finishListeners === 0);
  check(
    "…and never reached git: the body is the refusal, not a pull's output",
    noHeader.body.includes(UPDATE_HEADER) && !noHeader.body.includes("fatal:")
  );

  const wrongHeader = recordingResponse();
  await handleUpdateEndpoint(postRequest({ [UPDATE_HEADER]: "not-it" }), wrongHeader.res, notARepo);
  check("a POST carrying the wrong value is refused too", wrongHeader.statusCode === 403);

  const canRestartValue = recordingResponse();
  await handleUpdateEndpoint(postRequest({ [UPDATE_HEADER]: CAN_RESTART_HEADER_VALUE }), canRestartValue.res, notARepo);
  check("⚠️  …including /can-restart's value, the neighbour on the same sheet", canRestartValue.statusCode === 403);

  const withHeader = recordingResponse();
  await handleUpdateEndpoint(postRequest({ [UPDATE_HEADER]: UPDATE_HEADER_VALUE }), withHeader.res, notARepo);
  check(
    "⚠️  a POST carrying the header gets past the guard and reaches git — 500 in a directory that is " +
      "not a repo, so the guard is shown to refuse SOME requests rather than all of them",
    withHeader.statusCode === 500
  );
  check("…and still armed no restart, because the pull did not succeed", withHeader.finishListeners === 0);

  // --- 4. the dashboard's half of the wire -------------------------------------
  //
  // ⚠️ Scoped to ONE FUNCTION BODY EACH, not to the file. Both literals live in
  // public/views/pi-actions.js, so a file-wide search still finds both after they have been
  // SWAPPED between the two fetches — while every POST the dashboard makes answers 403 and
  // the rider is told only that the request failed.

  console.log("\n4. the page's end, pinned inside the function that sends it");

  const page = await readFile(new URL("../public/views/pi-actions.js", import.meta.url), "utf8");

  for (const [name, path, value] of [
    ["performUpdate", "/update", UPDATE_HEADER_VALUE],
    ["performCanRestart", "/can-restart", CAN_RESTART_HEADER_VALUE],
  ] as const) {
    const body = declarationBody(page, `async function ${name}(`);
    check(`${name}() was found at all — a pattern matching nothing would pass the two below in silence`, body !== "");
    check(`${name}() posts to ${path}`, body.includes(`fetch("${path}"`));
    check(
      `⚠️  …and sends "X-Cool-Eva": "${value}" from inside that same body`,
      body.includes(`"X-Cool-Eva": "${value}"`)
    );
  }
} finally {
  // check-update-endpoint.ts cleans its checkout up the same way. Without this every `npm test`
  // leaves a directory behind in the system temp dir — twenty of them after one afternoon.
  await rm(notARepo, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "s" : ""}`);
  process.exitCode = 1;
} else {
  console.log("✓ both Pi-maintenance endpoints refuse a request that carries no header, the wrong value, an empty");
  console.log("  one, a neighbour's or a duplicate — and the page sends the right literal from inside the right");
  console.log("  function. A CSRF barrier, not authentication: docs/wifi-hardening.md");
}

/**
 * Runs one request with console.warn recorded, so what the ENDPOINT did can be asserted rather
 * than what it answered. Restored in a `finally`: a throw here would leave the suite's own
 * warnings swallowed for every later check in this process.
 */
async function withWarningsRecorded<Result>(
  request: () => Promise<Result>
): Promise<{ result: Result; warnings: string[] }> {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(argument => String(argument)).join(" "));
  };
  try {
    return { result: await request(), warnings };
  } finally {
    console.warn = realWarn;
  }
}

/** One request at the loopback server, and how the endpoint answered it. */
async function post(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}${path}`, { method: "POST", headers });
  return { status: response.status, body: await response.text() };
}

/**
 * Two X-Cool-Eva headers on one request, which `fetch` will not build from an object —
 * Node joins duplicates into `can-restart, can-restart`, and the point is that the
 * comparison is exact, so joining fails CLOSED rather than open.
 */
async function postDuplicateHeader(): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}/can-restart`, {
    method: "POST",
    headers: [
      [CAN_RESTART_HEADER, CAN_RESTART_HEADER_VALUE],
      [CAN_RESTART_HEADER, CAN_RESTART_HEADER_VALUE],
    ],
  });
  return { status: response.status, body: await response.text() };
}

/**
 * Every `export const …_HEADER_VALUE = "…"` in src/http/, read off the files rather than
 * listed here: a list would be the one place a seventh endpoint could fail to appear, and
 * an endpoint that quietly copied a neighbour's value is exactly what §1 is looking for.
 */
async function exportedHeaderValues(): Promise<{ file: string; value: string }[]> {
  const found: { file: string; value: string }[] = [];
  for (const [file, source] of await httpSources()) {
    for (const match of source.matchAll(/^export const \w*HEADER_VALUE = "([^"]+)";$/gm)) {
      found.push({ file: file.replace("src/http/", "").replace(".ts", ""), value: match[1] });
    }
  }
  return found;
}

/** Every handler in src/http/, read once and concurrently — the reads have nothing to do with each other. */
async function httpSources(): Promise<(readonly [string, string])[]> {
  const directory = new URL("../src/http/", import.meta.url);
  const entries = (await readdir(directory)).filter(entry => entry.endsWith(".ts")).sort();
  return await Promise.all(
    entries.map(async entry => [`src/http/${entry}`, await readFile(new URL(entry, directory), "utf8")] as const)
  );
}
