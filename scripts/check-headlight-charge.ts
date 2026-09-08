import Database from "better-sqlite3";

// Does connecting a charger turn the headlights off, and — if so — does that
// cutoff FOLLOW a charge signal that rides on the CAN bus (so it could in
// principle be reproduced by asserting that signal) or does it lead every
// bus-visible charge signal (so the VCU is reacting to a physical charge-port
// pin we never see)?
//
//   node --experimental-strip-types scripts/check-headlight-charge.ts [rides.db]
//
// Reads a rebuilt rides.db (scripts/decrypt-log.ts) read-only and reconstructs a
// joint timeline of the beam lamps and every charge indicator, in true write
// order (session_id, seq) — NOT ts, which is unclocked and steps (see src/db.ts).
//
// Charge episodes are derived ONLY from indicators with a real off-state:
//   - AC: charge_state (0x201 b0) == 2. 0x01 is NOT charging and 0x10 is
//     "BMS not charge-managing" (whole DC session AND the last ~2 s of AC), so
//     neither is a clean charging flag — see scripts/check-charge-mode.ts.
//   - DC: fast_dc_contactor (0x102 b3 bit0) == 1, the physical contactor monitor.
// The charge-manager frames (charge_manager_state, ac_charging, …) only exist on
// the bus while a cable is live, so after unplug they simply stop logging; a naive
// forward-fill would leave them stuck "on". They are carried as context only and
// are cleared at every session boundary.

const LAMP_KEYS = ["high_beam_lamp", "low_beam_lamp"];
const SWITCH_KEY = "high_beam";
// Charge indicators with a real off-state — safe to drive episode detection with.
const PRIMARY_CHARGE_KEYS = ["charge_state", "fast_dc_contactor", "charger_enabled"];
// Cable-only signals: cleared at session boundaries, shown as context.
const CONTEXT_CHARGE_KEYS = ["charge_manager_state", "charge_type", "ac_charging", "dc_charging"];
const ALL_KEYS = [SWITCH_KEY, ...LAMP_KEYS, ...PRIMARY_CHARGE_KEYS, ...CONTEXT_CHARGE_KEYS];

interface Event {
  session_id: number | null;
  seq: number | null;
  ts: number;
  key: string;
  value: number;
}

/** One reconstructed instant: which key just changed, plus the forward-filled state of every tracked signal. */
interface Instant {
  session_id: number | null;
  seq: number | null;
  ts: number;
  changedKey: string;
  state: Record<string, number | null>;
}

main();

function main(): void {
  const dbPath = process.argv[2] ?? "rides.db";
  const db = new Database(dbPath, { readonly: true });

  const present = presentKeys(db, ALL_KEYS);
  const missing = ALL_KEYS.filter(key => !present.has(key));
  console.log(`DB: ${dbPath}`);
  console.log(`keys present: ${[...present].join(", ") || "(none)"}`);
  if (missing.length > 0) {
    console.log(`keys MISSING (never logged): ${missing.join(", ")}`);
  }

  const canDeriveCharge = present.has("charge_state") || present.has("fast_dc_contactor");
  if (!canDeriveCharge) {
    console.log("\nNo charge_state or fast_dc_contactor rows — cannot detect charge episodes. Stopping.");
    return;
  }

  const events = loadEvents(db, [...present]);
  if (events.length === 0) {
    console.log("\nNo readings for any tracked signal. Stopping.");
    return;
  }
  const nullOrder = events.some(event => event.session_id === null || event.seq === null);
  if (nullOrder) {
    console.log(
      "\n⚠️  some rows have NULL session_id/seq (sealed before the counter existed); ordering falls back to ts for those and may be unreliable."
    );
  }

  const instants = reconstructTimeline(events);
  const episodes = findChargeEpisodes(instants);

  reportEpisodes(episodes, instants);
  reportLampOffSpecificity(instants);
}

/** Which of `keys` actually appear in the signal table. */
function presentKeys(db: Database.Database, keys: string[]): Set<string> {
  const placeholders = keys.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT key FROM signal WHERE key IN (${placeholders})`).all(...keys) as { key: string }[];
  return new Set(rows.map(row => row.key));
}

function loadEvents(db: Database.Database, keys: string[]): Event[] {
  const placeholders = keys.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT r.session_id AS session_id, r.seq AS seq, r.ts AS ts, s.key AS key, r.value AS value
       FROM reading r JOIN signal s ON s.id = r.signal_id
       WHERE s.key IN (${placeholders})
       ORDER BY r.session_id, r.seq, r.ts`
    )
    .all(...keys) as Event[];
  return rows;
}

/** Walk events in write order, forward-filling each signal; clear cable-only signals when the session changes. */
function reconstructTimeline(events: Event[]): Instant[] {
  const state: Record<string, number | null> = {};
  for (const key of ALL_KEYS) {
    state[key] = null;
  }
  let currentSession = events[0]?.session_id ?? null;
  const instants: Instant[] = [];

  for (const event of events) {
    if (event.session_id !== currentSession) {
      currentSession = event.session_id;
      for (const key of CONTEXT_CHARGE_KEYS) {
        state[key] = null;
      }
    }
    state[event.key] = event.value;
    instants.push({
      session_id: event.session_id,
      seq: event.seq,
      ts: event.ts,
      changedKey: event.key,
      state: { ...state },
    });
  }
  return instants;
}

/** AC (charge_state==2) or DC (fast_dc_contactor==1) — the two clean-off-state indicators. */
function isCharging(state: Record<string, number | null>): boolean {
  return state.charge_state === 2 || state.fast_dc_contactor === 1;
}

interface Episode {
  startIndex: number;
  session_id: number | null;
}

/** Contiguous runs (within a session) where isCharging() holds. */
function findChargeEpisodes(instants: Instant[]): Episode[] {
  const episodes: Episode[] = [];
  let charging = false;
  for (let index = 0; index < instants.length; index++) {
    const nowCharging = isCharging(instants[index].state);
    if (nowCharging && !charging) {
      episodes.push({ startIndex: index, session_id: instants[index].session_id });
    }
    charging = nowCharging;
  }
  return episodes;
}

function reportEpisodes(episodes: Episode[], instants: Instant[]): void {
  console.log(`\n=== ${episodes.length} charge episode(s) ===`);
  if (episodes.length === 0) {
    console.log("No charge episodes found — nothing to correlate.");
    return;
  }

  let lampWentOff = 0;
  let lampAlreadyOff = 0;
  let lampStayedOn = 0;
  const lagsSeq: number[] = [];
  const lagsMs: number[] = [];

  for (const episode of episodes) {
    const start = instants[episode.startIndex];
    const mode = start.state.charge_state === 2 ? "AC (charge_state=2)" : "DC (fast_dc_contactor=1)";
    console.log(`\n--- session ${start.session_id}, charge-on at seq ${start.seq}, ${fmtTs(start.ts)} [${mode}] ---`);
    console.log(
      `    lamps at charge-on: high_beam_lamp=${fmt(start.state.high_beam_lamp)} low_beam_lamp=${fmt(start.state.low_beam_lamp)} switch high_beam=${fmt(start.state.high_beam)}`
    );

    // Look forward, within the same session and while charging stays true, for a lamp 1->0 transition.
    let priorLamp = { high_beam_lamp: start.state.high_beam_lamp, low_beam_lamp: start.state.low_beam_lamp };
    const alreadyOff = start.state.high_beam_lamp === 0 && start.state.low_beam_lamp === 0;
    let found = false;

    for (let index = episode.startIndex + 1; index < instants.length; index++) {
      const instant = instants[index];
      if (instant.session_id !== start.session_id) break;
      if (!isCharging(instant.state)) break;
      const turnedOff =
        (priorLamp.high_beam_lamp !== 0 && instant.state.high_beam_lamp === 0) ||
        (priorLamp.low_beam_lamp !== 0 && instant.state.low_beam_lamp === 0);
      if (turnedOff && LAMP_KEYS.includes(instant.changedKey)) {
        const seqLag = start.seq !== null && instant.seq !== null ? instant.seq - start.seq : NaN;
        const msLag = instant.ts - start.ts;
        console.log(
          `    ▶ ${instant.changedKey} -> 0 at seq ${instant.seq} (Δseq=${fmtNum(seqLag)}, Δt=${fmtNum(msLag)} ms after charge-on)`
        );
        if (!Number.isNaN(seqLag)) lagsSeq.push(seqLag);
        lagsMs.push(msLag);
        found = true;
        break;
      }
      priorLamp = { high_beam_lamp: instant.state.high_beam_lamp, low_beam_lamp: instant.state.low_beam_lamp };
    }

    if (alreadyOff) {
      console.log("    (both lamps were ALREADY off at charge-on — no transition to time)");
      lampAlreadyOff++;
    } else if (found) {
      lampWentOff++;
    } else {
      console.log("    (lamps did NOT turn off during this episode)");
      lampStayedOn++;
    }
  }

  console.log(`\n=== summary ===`);
  console.log(`episodes: ${episodes.length}`);
  console.log(`  lamp turned off AFTER charge-on: ${lampWentOff}`);
  console.log(`  lamp already off at charge-on:   ${lampAlreadyOff}`);
  console.log(`  lamp stayed on:                  ${lampStayedOn}`);
  if (lagsSeq.length > 0) {
    console.log(
      `  Δseq charge-on -> lamp-off: min=${Math.min(...lagsSeq)} median=${median(lagsSeq)} max=${Math.max(...lagsSeq)}`
    );
  }
  if (lagsMs.length > 0) {
    console.log(
      `  Δt   charge-on -> lamp-off: min=${Math.min(...lagsMs)} median=${median(lagsMs)} max=${Math.max(...lagsMs)} ms`
    );
  }
  console.log(
    "\nInterpretation: a positive, consistent Δseq/Δt means a bus-visible charge signal LEADS the\n" +
      "lamp-off (the cutoff plausibly keys off CAN — worth investigating spoofing). If lamps were\n" +
      "already off before any charge signal, or never off, the cutoff is not explained by these\n" +
      "signals and is likely driven by a physical charge-port pin we cannot see on the bus."
  );
}

/** Every lamp 1->0 transition: was charging active when it happened? Tells us how specific the cutoff is to charging. */
function reportLampOffSpecificity(instants: Instant[]): void {
  let offWhileCharging = 0;
  let offWhileNotCharging = 0;
  const prior: Record<string, number | null> = { high_beam_lamp: null, low_beam_lamp: null };

  for (const instant of instants) {
    if (LAMP_KEYS.includes(instant.changedKey)) {
      const key = instant.changedKey;
      if (prior[key] !== null && prior[key] !== 0 && instant.state[key] === 0) {
        if (isCharging(instant.state)) {
          offWhileCharging++;
        } else {
          offWhileNotCharging++;
        }
      }
    }
    prior.high_beam_lamp = instant.state.high_beam_lamp;
    prior.low_beam_lamp = instant.state.low_beam_lamp;
  }

  console.log(`\n=== lamp-off specificity (all sessions) ===`);
  console.log(`  lamp 1->0 while charging:     ${offWhileCharging}`);
  console.log(`  lamp 1->0 while NOT charging: ${offWhileNotCharging}`);
  console.log("  (if the second number is large, headlights go off for reasons unrelated to charging too)");
}

function fmt(value: number | null): string {
  return value === null ? "—" : String(value);
}

function fmtNum(value: number): string {
  return Number.isNaN(value) ? "n/a" : String(value);
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString();
}

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
