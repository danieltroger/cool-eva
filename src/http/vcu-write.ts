import type { IncomingMessage, ServerResponse } from "http";
import type { ServiceWriteRequest, ServiceWriteResult, VcuWriteRunner, VcuWriteStatus } from "../vcu/write-runner.ts";

// /vcu-write — service mode's WRITE surface.
//
//   GET   the allowlist, the gate, whether this Pi's clock is fit to copy, and the
//         last few lines of the audit journal. Touches nothing.
//   POST  do exactly one thing to the motorcycle.
//
// ⚠️ This is the second endpoint in this repo that causes traffic on the bike's bus,
// and the FIRST that changes anything. /vcu-read and /vcu-probe are read-only by
// construction — src/vcu/param-codec.ts's request union has three members and nowhere
// to put a value — and that has not changed. This is a separate door with separate
// locks, and it is closed by default.
//
// ⚠️ It wants `X-Cool-Eva: service-write`, deliberately NOT the read path's
// `service-mode`. Neither value is a secret — being unsettable cross-origin is the
// whole property — but making them DIFFERENT means a caller that only knows about
// reads cannot reach a write by accident, including a script of the owner's own
// written before this endpoint existed.
//
// ⚠️ Several actions additionally require the caller to say what it thinks it is doing,
// because `curl` can reach this endpoint and the UI's two taps cannot follow it there:
//
//   set-service-point  confirm=set-service-point
//   clear-dtcs         confirm=clear-dtcs
//   sync-clock         confirm=<the UTC minute the caller displayed, ISO>
//   charge-current     amps=<whole amps>  confirm=charge-current-<amps>
//   charge-stop        confirm=charge-stop
//   reset-vcu          confirm=reset-vcu
//
// The clock one is not ceremony — it is the server-side half of "Is it <date and
// time>?", so a page left open since this morning cannot sync this morning's time.
// Why a header at all, and the rest of the argument: docs/diagnostics-and-checks.md §7.2–7.3.

/** The header, and the value that is not the read path's. */
export const SERVICE_WRITE_HEADER = "x-cool-eva";

export const SERVICE_WRITE_HEADER_VALUE = "service-write";

export interface VcuWriteResponse {
  status: VcuWriteStatus;
  /** What the action did, or null when nothing was attempted. */
  result: ServiceWriteResult | null;
  /** Why nothing was attempted, or why a request was rejected before it reached the bus. */
  message: string | null;
}

export interface VcuWriteEndpointOptions {
  runner: VcuWriteRunner;
}

export async function handleVcuWriteEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: VcuWriteEndpointOptions
): Promise<void> {
  if (req.method === "GET") {
    // Deliberately NOT behind the header. Reading what may be written, what the gate
    // says and what was done last week is how the page explains why a button is
    // unavailable, and none of it goes near the bike.
    await respond(res, 200, options, null, null);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, POST" });
    res.end("use GET to see what may be written, POST to write one thing\n");
    return;
  }
  if (req.headers[SERVICE_WRITE_HEADER] !== SERVICE_WRITE_HEADER_VALUE) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`writing needs the ${SERVICE_WRITE_HEADER}: ${SERVICE_WRITE_HEADER_VALUE} header\n`);
    return;
  }

  // Parsed and confirmed before anything is started, so a typo is a message rather
  // than a diagnostic session opened for a request that could never have been honoured.
  const parsed = parseWriteRequest(url.searchParams, Date.now());
  if (!parsed.ok) {
    // 400, not 409: the request itself is wrong and re-sending it unchanged will
    // always be wrong. 409 is for a busy bus or a bike that may not be serviced.
    await respond(res, 400, options, null, parsed.reason);
    return;
  }

  const answer = await options.runner.perform(parsed.request);
  if (!answer.ok) {
    await respond(res, 409, options, null, answer.reason);
    return;
  }
  // 200 even when the bike refused, and even for a read-back mismatch. Those are
  // ANSWERS — the micro is there and declined, or it accepted and the cell did not
  // take — and turning them into HTTP errors would collapse the distinction the
  // codec works hardest to keep. `result.succeeded` is where the page reads the
  // verdict from.
  await respond(res, 200, options, answer.result, null);
}

/**
 * Turns a query string into one action, or into a reason. Pure.
 *
 * `nowMs` is passed in rather than read so the confirmation window below is testable
 * without waiting for a minute to tick over.
 */
export function parseWriteRequest(
  params: URLSearchParams,
  nowMs: number
): { ok: true; request: ServiceWriteRequest } | { ok: false; reason: string } {
  const action = params.get("action");
  switch (action) {
    case "parameter": {
      const name = params.get("name");
      if (!name) {
        return { ok: false, reason: "which parameter? pass name=" };
      }
      const value = parseNumber(params.get("value"));
      if (value === null) {
        return { ok: false, reason: `value must be a whole number, not ${params.get("value") ?? "(nothing)"}` };
      }
      const expected = parseNumber(params.get("expected"));
      if (expected === null) {
        return {
          ok: false,
          reason:
            "expected= must carry the value you read off the bike. Every write is a compare-and-swap: the Pi re-reads the parameter and refuses if it does not match.",
        };
      }
      return { ok: true, request: { kind: "parameter", name, value, expectedCurrent: expected } };
    }
    case "bit": {
      const name = params.get("name");
      const bit = params.get("bit");
      if (!name || !bit) {
        return { ok: false, reason: "a bit toggle needs name= and bit=" };
      }
      const expected = parseNumber(params.get("expected"));
      if (expected === null) {
        return {
          ok: false,
          reason:
            "expected= must carry the whole config word as you read it off the bike — the new word is computed from it, so it cannot be guessed",
        };
      }
      const on = params.get("on");
      if (on !== "0" && on !== "1") {
        return { ok: false, reason: "on= must be 0 or 1" };
      }
      return { ok: true, request: { kind: "bit", name, bit, on: on === "1", expectedCurrent: expected } };
    }
    case "parameters": {
      // A batch is repeated `w=NAME:VALUE:EXPECTED`, one per parameter — colon-packed rather
      // than three parallel arrays so a name can never end up paired with another's value if
      // the query is reordered. Each carries its own compare-and-swap `expected`, exactly as a
      // single `parameter` write does; no confirm token, because it is many parameter writes
      // (the guarded, reversible action), not one of the irreversible ones. The runner caps the
      // count, plans every name against the allowlist, and refuses the whole batch on any bad one.
      const entries = params.getAll("w");
      if (entries.length === 0) {
        return {
          ok: false,
          reason:
            "a batch write needs at least one w=NAME:VALUE:EXPECTED — the value and the value you read off the bike",
        };
      }
      const writes: { name: string; value: number; expectedCurrent: number }[] = [];
      for (const entry of entries) {
        const parts = entry.split(":");
        if (parts.length !== 3) {
          return {
            ok: false,
            reason: `each w= must be NAME:VALUE:EXPECTED (three colon-separated fields), not "${entry}"`,
          };
        }
        const name = parts[0].trim();
        if (name.length === 0) {
          return { ok: false, reason: `a w= entry has no parameter name: "${entry}"` };
        }
        const value = parseNumber(parts[1]);
        if (value === null) {
          return { ok: false, reason: `${name}: value must be a whole number, not ${parts[1] || "(nothing)"}` };
        }
        const expected = parseNumber(parts[2]);
        if (expected === null) {
          return {
            ok: false,
            reason: `${name}: expected= must carry the value you read off the bike — every write in the batch is still a compare-and-swap`,
          };
        }
        writes.push({ name, value, expectedCurrent: expected });
      }
      return { ok: true, request: { kind: "parameters", writes } };
    }
    case "read-service-stamp":
      return { ok: true, request: { kind: "read-service-stamp" } };
    case "set-service-point":
      if (params.get("confirm") !== "set-service-point") {
        return {
          ok: false,
          reason:
            "Set Service Point is irreversible — it stamps the bike's current clock and odometer as the last service, and there is no unset. Pass confirm=set-service-point.",
        };
      }
      return { ok: true, request: { kind: "set-service-point" } };
    case "clear-dtcs":
      if (params.get("confirm") !== "clear-dtcs") {
        return {
          ok: false,
          reason:
            "Clearing trouble codes is irreversible — this bike's stored list has been accumulating since before anyone started looking, and the freeze frame goes with it. Pass confirm=clear-dtcs.",
        };
      }
      return { ok: true, request: { kind: "clear-dtcs" } };
    case "sync-clock": {
      const confirmed = params.get("confirm");
      if (!confirmed) {
        return {
          ok: false,
          reason:
            "Pass confirm=<the UTC minute you showed, e.g. 2026-08-16T14:03Z>. The Pi checks it is still that minute, so a page left open cannot sync a stale time.",
        };
      }
      if (confirmed !== utcMinute(nowMs)) {
        // The server-side half of "Is it <date and time>?". A mismatch is not a
        // formatting quibble — it means the time the owner agreed to has passed, or
        // the Pi's clock moved between the page rendering and the button being
        // pressed. Either way the answer they gave was to a different question.
        return {
          ok: false,
          reason: `You confirmed ${confirmed}, but this Pi now reads ${utcMinute(nowMs)}. Re-read the time and confirm again.`,
        };
      }
      return { ok: true, request: { kind: "sync-clock" } };
    }
    case "charge-current": {
      const amps = parseNumber(params.get("amps"));
      if (amps === null) {
        return { ok: false, reason: `amps must be a whole number, not ${params.get("amps") ?? "(nothing)"}` };
      }
      // The confirm carries the amps, so a page showing one value cannot POST another — the
      // AC/DC choice and the ceiling are the live bus's to make, but the number is the owner's.
      if (params.get("confirm") !== `charge-current-${amps}`) {
        return {
          ok: false,
          reason: `Commanding the charge current actuates the bike's charging. Pass confirm=charge-current-${amps} to confirm ${amps} A.`,
        };
      }
      return { ok: true, request: { kind: "charge-current", amps } };
    }
    case "charge-stop":
      // Stopping actuates the bike's charging (the benign direction — it ends a charge), so it
      // carries the same one-word confirm the two-tap UI sends but curl must state deliberately.
      if (params.get("confirm") !== "charge-stop") {
        return {
          ok: false,
          reason: "Stopping the charge actuates the bike's charging. Pass confirm=charge-stop.",
        };
      }
      return { ok: true, request: { kind: "charge-stop" } };
    case "reset-vcu":
      // Resetting actuates the bike (both micros restart, dropping it off the bus briefly), so it
      // carries the same one-word confirm the two-tap UI sends but curl must state deliberately.
      if (params.get("confirm") !== "reset-vcu") {
        return {
          ok: false,
          reason:
            "Resetting the VCU restarts both micros and drops the bike off the bus briefly. Pass confirm=reset-vcu.",
        };
      }
      return { ok: true, request: { kind: "reset-vcu" } };
    default:
      return {
        ok: false,
        reason: `action must be one of parameter, parameters, bit, read-service-stamp, set-service-point, sync-clock, clear-dtcs, charge-current, charge-stop, reset-vcu — not ${action ?? "(nothing)"}`,
      };
  }
}

/** `2026-08-16T14:03Z`. Minute resolution: a second-resolution echo could never match. */
export function utcMinute(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16)}Z`;
}

/**
 * `0x1F` and `31` both, because a value copied out of a hex dump is the common case.
 *
 * ⚠️ The `-` is moved to the FRONT of the digits and handed to `parseInt`, rather than
 * stripped and re-applied as a multiplier. The multiplier version applied the sign
 * twice — `parseInt("-50", 16)` is already −80, and multiplying by −1 turned it back
 * into **+80**. So `value=-0x50` parsed as 80: a negative that every allowlist entry
 * would have refused with a reason instead became a positive, in-range value on its
 * way to a calibration EEPROM. Caught in review, never shipped; check-vcu-params.ts
 * §16 covers it now.
 */
function parseNumber(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  const text = raw.trim();
  const value = /^-?0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.replace(/^(-?)0x/i, "$1"), 16) : Number(text);
  return Number.isInteger(value) ? value : null;
}

async function respond(
  res: ServerResponse,
  statusCode: number,
  options: VcuWriteEndpointOptions,
  result: ServiceWriteResult | null,
  message: string | null
): Promise<void> {
  const payload: VcuWriteResponse = { status: await options.runner.status(), result, message };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    // A live gate, a live clock verdict and a journal that just grew. A cached copy
    // of any of the three would be worse than no answer — the clock one especially,
    // since its whole job is to describe this second.
    "Cache-Control": "no-store",
  });
  res.end(body);
}
