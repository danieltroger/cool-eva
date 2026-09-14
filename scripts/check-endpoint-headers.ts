import { createServer } from "http";
import type { AddressInfo } from "net";
import type { IncomingMessage } from "http";
import { readFile, readdir, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CAN_RESTART_HEADER, CAN_RESTART_HEADER_VALUE, handleCanRestartEndpoint } from "../src/http/can-restart.ts";
import { UPDATE_HEADER, UPDATE_HEADER_VALUE, handleUpdateEndpoint } from "../src/http/update.ts";
import { FAN_HEADER_VALUE } from "../src/http/fan.ts";
import { recordingResponse } from "./recording-response.ts";

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
  `⚠️  no two of the ${headerValues.length} endpoints share a value — a caller built for one cannot reach another`,
  new Set(headerValues.map(entry => entry.value)).size === headerValues.length
);

// --- 2. /can-restart, against a real server on loopback -----------------------

console.log("\n2. /can-restart: what a page on the bike's wifi can do to the bus");

const server = createServer((req, res) => {
  void handleCanRestartEndpoint(req, res, NO_SUCH_IFACE);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  const refused = await post("/can-restart");
  check("⚠️  a POST with NO header is refused with 403 — this is the cross-origin form", refused.status === 403);
  check(
    "…and it never reached restartCanLink: a request that got past the guard comes back " +
      "`Restart failed`, which only that catch writes",
    !refused.body.includes("Restart failed")
  );
  check("…and the refusal names the header it wanted", refused.body.includes(CAN_RESTART_HEADER));

  const wrongValue = await post("/can-restart", { [CAN_RESTART_HEADER]: "not-it" });
  check("a POST carrying the WRONG value is refused too, so the name alone is not the key", wrongValue.status === 403);

  const fanValue = await post("/can-restart", { [CAN_RESTART_HEADER]: FAN_HEADER_VALUE });
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

  const accepted = await post("/can-restart", { [CAN_RESTART_HEADER]: CAN_RESTART_HEADER_VALUE });
  check(
    "⚠️  a POST carrying the header gets past the guard and reaches restartCanLink — 500 against " +
      `an interface no machine has, which is how this check can prove that without touching can0`,
    accepted.status === 500 && accepted.body.includes("Restart failed")
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

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "s" : ""}`);
  process.exitCode = 1;
} else {
  console.log("✓ both Pi-maintenance endpoints refuse a request that carries no header, the wrong value, an empty");
  console.log("  one, a neighbour's or a duplicate — and the page sends the right literal from inside the right");
  console.log("  function. A CSRF barrier, not authentication: docs/wifi-hardening.md");
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

/** A POST with whatever headers, for the handlers §3 calls directly rather than over a socket. */
function postRequest(headers: Record<string, string> = {}): IncomingMessage {
  return { method: "POST", headers } as unknown as IncomingMessage;
}

/**
 * Every `export const …_HEADER_VALUE = "…"` in src/http/, read off the files rather than
 * listed here: a list would be the one place a seventh endpoint could fail to appear, and
 * an endpoint that quietly copied a neighbour's value is exactly what §1 is looking for.
 */
async function exportedHeaderValues(): Promise<{ file: string; value: string }[]> {
  const directory = new URL("../src/http/", import.meta.url);
  const found: { file: string; value: string }[] = [];
  for (const entry of (await readdir(directory)).sort()) {
    if (!entry.endsWith(".ts")) {
      continue;
    }
    const source = await readFile(new URL(entry, directory), "utf8");
    for (const match of source.matchAll(/^export const \w*HEADER_VALUE = "([^"]+)";$/gm)) {
      found.push({ file: entry.replace(".ts", ""), value: match[1] });
    }
  }
  return found;
}

/** The body of a named function declaration, or "" if it is not there at all. */
function declarationBody(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  if (at === -1) {
    return "";
  }
  const start = source.indexOf("{", at);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return "";
}
