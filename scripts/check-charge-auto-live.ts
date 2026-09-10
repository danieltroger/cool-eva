import { CHARGE_AUTO_REASON } from "../src/charge/auto-curve.ts";
import { CHARGE_AUTO_REASON_TEXT } from "../src/http/charge-auto.ts";
import { HEARTBEAT_MS } from "../src/ws.ts";
import {
  AC_SESSION,
  COMMAND_MS,
  DC_SESSION,
  NO_SESSION,
  SLOW_REPLY_MS,
  applyWriteStatus,
  controllerSentence,
  countOf,
  failNextChargeAutoRead,
  fetchChargeWriteStatus,
  heartbeat,
  holdNextReply,
  patch,
  pause,
  pi,
  setWritesOn,
  settle,
} from "./charge-auto-live-harness.ts";

// Whether the charge tab's automatic-current tile still says what the Pi is doing WHILE it does it.
//
//   node --experimental-strip-types scripts/check-charge-auto-live.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ⚠️ THE BUG (#200, from the road on 2026-09-10). The tile re-read /charge-auto only when
// `charge_auto_reason` changed value. The v1 rule changed reason almost every tick, so that was
// enough; #193's rule sits in one reason for many ticks while the current moves 1-15 A per tick, so
// nothing refreshed and the sentence — "Commanding x A" included — froze until a page reload.
//
// The fake Pi and the fake browser are ./charge-auto-live-harness.ts, which drives the REAL view
// and the REAL store; this file is only the assertions. Importing it is what stands `fetch` in
// before those modules load, so the import above is load-bearing rather than tidy.
//
// What it cannot show: that the Pi records what it claims to. src/charge/auto.ts's own records are
// scripts/check-charge-auto.ts's business, and the bus is nobody's without a bike.

const failures: string[] = [];

// ── §1 ⚠️ THE BUG: the amps move, the reason stands still ──────────────────
//
// Driven as `runTick` really emits it. src/charge/auto.ts records the reason at :197, awaits the
// command at :203 and records the amps at :206 — different microtasks, and src/ws.ts:193 turns
// every batch into its own patch, so the browser gets TWO patches seconds apart and pays two
// fetches. The first reads `commandedAmps` while the command is still in flight and gets the old
// one; the second is what makes the tile right. Asserting a single combined patch would pin an
// ordering the bike never produces.
patch({ charge_manager_state: DC_SESSION });
await settle();
pi.reason = CHARGE_AUTO_REASON.CLOSING;
patch({ charge_auto_reason: CHARGE_AUTO_REASON.CLOSING });
await settle();
pi.commandedAmps = 70;
patch({ charge_auto_target_a: 70 });
await settle();
expect("§1a", `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.CLOSING]} Commanding 70 A.`);

// The step that froze the tile: one reason, a current that keeps moving.
pi.commandedAmps = 62;
patch({ charge_auto_target_a: 62 });
await settle();
expect(
  "§1b the controller eased the current 70 → 62 A without changing its reason, which is what #193's " +
    "rule does for many ticks at a time",
  `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.CLOSING]} Commanding 62 A.`
);

// ── §2 the reason alone still wakes it ─────────────────────────────────────
pi.reason = CHARGE_AUTO_REASON.SETTLED;
patch({ charge_auto_reason: CHARGE_AUTO_REASON.SETTLED });
await settle();
expect("§2", `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.SETTLED]} Commanding 62 A.`);

// ── §3 ⚠️ THE GUARD: a heartbeat still costs nothing ───────────────────────
//
// The property the value guard exists for, and the one this fix could plausibly break. ws.ts
// heartbeats a FULL SNAPSHOT every HEARTBEAT_MS and store.js assigns a freshly parsed object, so
// every signal's identity churns whether or not its number moved. Unguarded, the derive would be a
// 0.2 Hz poll of an HTTP endpoint on a phone strapped to a handlebar.
{
  const before = countOf("/charge-auto");
  for (let beat = 0; beat < 5; beat += 1) {
    heartbeat();
    await settle();
  }
  const beats = countOf("/charge-auto") - before;
  if (beats !== 0) {
    failures.push(
      `§3 five heartbeats repeating the same values cost ${beats} fetch(es) of /charge-auto — the guard is ` +
        `gone and the tile now polls the Pi at ${(1000 / HEARTBEAT_MS).toFixed(1)} Hz`
    );
  }
}

// ── §4 both gates hold: not a DC charge, and writes switched off ───────────
//
// ⚠️ TWO halves, because an AC session does not exercise the second: `sessionLive` stays true, so
// charge-write.js never drops the status and writesEnabled() stays on. The read-only phone — one
// that never enabled writes — is the `enabled: false` half, and it is the claim that keeps the
// charge tab a pure WebSocket consumer for everyone else.
{
  const before = countOf("/charge-auto");
  patch({ charge_manager_state: AC_SESSION });
  await settle();
  patch({ charge_auto_target_a: 48 });
  await settle();
  if (countOf("/charge-auto") !== before) {
    failures.push("§4 an AC session fetched /charge-auto — the controller is DC-only and the tile is hidden");
  }
  patch({ charge_manager_state: DC_SESSION });
  await settle();
  // Back on DC the tile is commandable again, and a tile that just became commandable must re-read
  // the Pi rather than render whatever it last heard.
  if (countOf("/charge-auto") === before) {
    failures.push("§4 returning to a DC charge did not re-read /charge-auto, so the tile shows pre-AC state");
  }

  // ⚠️ The Pi SAYING no, through the real fetchChargeWriteStatus(), rather than applyWriteStatus(null)
  // — that is the session-end clear, which is §7's path and would prove the wrong thing here.
  const beforeWritesOff = countOf("/charge-auto");
  setWritesOn(false);
  await fetchChargeWriteStatus();
  await settle();
  patch({ charge_auto_target_a: 44 });
  await settle();
  if (countOf("/charge-auto") !== beforeWritesOff) {
    failures.push(
      "§4 a phone with writes switched off fetched /charge-auto — the tile is inert there, and the read-only " +
        "screen is supposed to stay a pure WebSocket consumer"
    );
  }
}

// ── §5 the number comes from the ENDPOINT, never from the signal ───────────
//
// ⚠️ The assertion the rejected alternative fails. Rendering the amps straight off
// `charge_auto_target_a` looks equivalent and is not: forgetSession() (src/charge/auto.ts:262)
// nulls the controller's own `commandedAmps` and records nothing, so the signal outlives the
// session that produced it and the tile would print a current this charge never commanded. The
// reason is moved here so the refresh fires either way — this section is about which number wins,
// not about what wakes the tile.
// Writes back on for the rest of the run, through the same door §4 shut.
setWritesOn(true);
await fetchChargeWriteStatus();
await settle();
pi.reason = CHARGE_AUTO_REASON.NEAR_CEILING;
pi.commandedAmps = 55;
patch({ charge_auto_reason: CHARGE_AUTO_REASON.NEAR_CEILING, charge_auto_target_a: 40 });
await settle();
expect(
  "§5 the signal says 40 A and the Pi says it commanded 55 A",
  `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.NEAR_CEILING]} Commanding 55 A.`
);

// ── §6 ⚠️ A MOVE THAT LANDS WHILE THE GATE IS SHUT IS NOT LOST ─────────────
//
// The guard must not be consumed on a run that did not refresh. Consumed above the gate — which is
// what shipped — a reason that moves while writes are momentarily off advances `lastReason`, the
// refresh never fires, and the move is gone for good: the tile then sits on the previous sentence
// until the controller happens to decide something different, which at AUTO_TICK_MS = 60 s and a
// settled rule can be a very long time. The window is real: charge-write.js clears the status on
// the session edge and the reopening GET is an async HTTP round trip.
{
  // The session-edge clear, not the stub — charge-write.js:121 is what really runs here, and the
  // reopening fetchChargeWriteStatus() below is the async round trip the change has to survive.
  applyWriteStatus(null);
  const before = countOf("/charge-auto");
  pi.reason = CHARGE_AUTO_REASON.HARD_CEILING;
  patch({ charge_auto_reason: CHARGE_AUTO_REASON.HARD_CEILING });
  await settle();
  if (countOf("/charge-auto") !== before) {
    failures.push("§6 the tile fetched /charge-auto with the write gate shut, which §4 says it must not");
  }
  await fetchChargeWriteStatus();
  await settle();
  heartbeat();
  await settle();
  expect(
    "§6 the reason moved to HARD_CEILING while the write gate was shut, and the gate then reopened",
    `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.HARD_CEILING]} Commanding 55 A.`
  );
}

// ── §7 ⚠️ THE SESSION BOUNDARY, WHERE NO SIGNAL MOVES AT ALL ───────────────
//
// forgetSession() (src/charge/auto.ts:262-267) nulls `commandedAmps` on the `charge_manager_state`
// edge and RECORDS NOTHING — and it does not reset `context.reason` either. So for up to one 60 s
// tick /charge-auto answers "commanding nothing" with the previous session's reason, while both
// signals still hold the previous session's values. Nothing patches, so no guard can notice: the
// tile keeps saying "Commanding 35 A" about a charge that has commanded nothing. What corrects it
// is onChargeSessionEnd() clearing `loaded` and the just-commandable wake-up on the next session.
{
  pi.reason = CHARGE_AUTO_REASON.AT_FLOOR;
  pi.commandedAmps = 35;
  patch({ charge_auto_reason: CHARGE_AUTO_REASON.AT_FLOOR, charge_auto_target_a: 35 });
  await settle();
  expect(
    "§7 (setting up) the tile is current before the cable comes out",
    `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.AT_FLOOR]} Commanding 35 A.`
  );

  // The cable out, and the Pi's forgetSession() with it: no record(), so no patch.
  patch({ charge_manager_state: NO_SESSION });
  await settle();
  pi.commandedAmps = null;

  // The cable back in, at the same charger, inside the same tick. Neither signal has moved.
  patch({ charge_manager_state: DC_SESSION });
  await settle();
  // ⚠️ The wanted text is the PREVIOUS session's reason, and that is not this check blessing it:
  // `forgetSession()` does not clear `context.reason`, so it really is what /charge-auto answers,
  // and the page's job is to show what the Pi says rather than to guess better. The amps stopped
  // lying here; the sentence has not, and closing that is Pi-side — issue #204.
  expect(
    "§7 a re-plug quick enough that no controller tick intervenes — neither signal moved, and the Pi is " +
      "commanding nothing (the reason is still the last session's, which is issue #204, not this)",
    CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.AT_FLOOR]
  );
}

// ── §8 ⚠️ TWO READS FROM ONE TICK, REPLIED OUT OF ORDER ────────────────────
//
// The wake-up on the commanded current is what makes this reachable, so it ships with the fix that
// creates it. One tick issues TWO reads tens of milliseconds apart — the reason at auto.ts:197, the
// amps at :206 — and the FIRST carries `commandedAmps` from before the command. If that reply lands
// last, `apply()` cannot tell it is older and the tile keeps the pre-command number for the rest of
// a settled charge. That is #200's own symptom, reached through #200's own fix; on main one tick
// fired one read and there was nothing to race.
{
  pi.reason = CHARGE_AUTO_REASON.CLOSING;
  pi.commandedAmps = 70;
  patch({ charge_auto_reason: CHARGE_AUTO_REASON.CLOSING, charge_auto_target_a: 70 });
  await settle(SLOW_REPLY_MS * 2);
  expect(
    "§8 (setting up) the tile is current before the tick",
    `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.CLOSING]} Commanding 70 A.`
  );

  // The reason, recorded while the Pi still holds the OLD amps, answered slowly.
  pi.reason = CHARGE_AUTO_REASON.SETTLED;
  holdNextReply(SLOW_REPLY_MS);
  patch({ charge_auto_reason: CHARGE_AUTO_REASON.SETTLED });
  await settle();
  // The command lands, and the amps are recorded — answered at once, so it overtakes.
  await pause(COMMAND_MS);
  pi.commandedAmps = 55;
  patch({ charge_auto_target_a: 55 });
  await settle(SLOW_REPLY_MS * 2);
  expect(
    "§8 the reason's read was answered after the amps' read, carrying the amps from before the command",
    `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.SETTLED]} Commanding 55 A.`
  );

  // ⚠️ And it must STAY right: a settled controller records nothing further, so a tile that lost
  // this race holds the wrong number for the rest of the charge rather than for one tick.
  for (let beat = 0; beat < 5; beat += 1) {
    heartbeat();
    await settle();
  }
  expect(
    "§8 five heartbeats later — a settled controller records nothing, so a lost race is permanent",
    `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.SETTLED]} Commanding 55 A.`
  );
}

// ── §9 ⚠️ A READ THAT FAILS MUST NOT COUNT AS ONE THAT ACTED ───────────────
//
// The same trap as §6, on the error path instead of the gated one: the guards are advanced before
// the round trip, so a read that ATTEMPTED and did not land leaves them agreeing with the signals
// and nothing will ever re-deliver the change. A settled controller records nothing further, so the
// tile then holds the wrong reason AND the wrong current for the rest of the charge. Wifi on a bike
// at a motorway charger drops packets; this is not a hypothetical path.
{
  // refresh()'s own console.warn reaches stderr here and is EXPECTED — this section makes a read
  // fail on purpose, and run-checks.ts inherits stdio. Said out loud so a reader of a green
  // `npm test` does not take the stack trace under it for a real fault.
  console.log("  (the 'charge-auto: status fetch failed' warning below is §9 failing a read on purpose)");
  pi.reason = CHARGE_AUTO_REASON.CLEAR;
  pi.commandedAmps = 66;
  failNextChargeAutoRead();
  patch({ charge_auto_reason: CHARGE_AUTO_REASON.CLEAR, charge_auto_target_a: 66 });
  await settle();
  expect(
    "§9 (setting up) the failed read left the tile on the previous answer, which is the safe direction",
    `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.SETTLED]} Commanding 55 A.`
  );

  // Nothing further moves — only the heartbeat re-sending what it already sent.
  heartbeat();
  await settle();
  expect(
    "§9 the next heartbeat retries the read the failure lost, rather than the guards having eaten it",
    `${CHARGE_AUTO_REASON_TEXT[CHARGE_AUTO_REASON.CLEAR]} Commanding 66 A.`
  );

  // ⚠️ And it must not have become a retry loop: once the read lands, the guards are consumed again
  // and the heartbeat goes back to costing nothing. §3's property, re-asserted after an error.
  const before = countOf("/charge-auto");
  for (let beat = 0; beat < 5; beat += 1) {
    heartbeat();
    await settle();
  }
  if (countOf("/charge-auto") !== before) {
    failures.push(
      `§9 five heartbeats after the recovery cost ${countOf("/charge-auto") - before} fetch(es) — rolling the ` +
        `guards back on failure turned the tile into a poll`
    );
  }
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-auto-live failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ the charge tab's controller sentence follows the Pi while it works: the commanded current moving with the ` +
    `reason unchanged updates it (the #200 freeze), the reason moving alone still does, five heartbeats repeating ` +
    `the same values cost nothing, neither an AC session nor a phone with writes off fetches anything, the amps ` +
    `shown are the endpoint's and not the signal's, a move that lands while the write gate is shut is not thrown ` +
    `away, a re-plug inside one controller tick never leaves the last session's "Commanding x A" on screen, ` +
    `one tick's two reads replied out of order still end on the commanded current, and a read that fails ` +
    `outright is retried on the next heartbeat rather than being swallowed`
);

/**
 * The tile's own text, against what the Pi's state says it should read.
 *
 * ⚠️ Failures go to `failures` rather than throwing, so one broken section still reports the rest —
 * the shape every check in this repo uses.
 */
function expect(label: string, wanted: string): void {
  const got = controllerSentence();
  if (got !== wanted) {
    failures.push(`${label}: the tile reads "${got}", the Pi's state says "${wanted}"`);
  }
}
