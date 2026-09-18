"""Did the fan loop ever stop applying its own answer?

Issue #282 reported that the automatic curve froze at 68 % for 42 minutes on 2026-09-09
while the pack climbed 43 -> 55 C. It had not: the rows came from four different boots
spliced onto one `ts` axis. This is the measurement that settles the general question the
issue raised, over the whole archive rather than over one afternoon.

For every boot, replay what the loop decided against what it had already commanded. Two
arms, because the loop has two branches that set a duty:

  curve  mode automatic, reason PACK_TEMPERATURE, a LIVE reading -> ridingCurveDuty(pack)
  dc     mode automatic, reason DC_SESSION                       -> MAX_DUTY_PERCENT

The DC arm exists because #282 was about a DC session, and a detector that judges only the
curve branch is silent on exactly that regime. The silence is self-concealing: a loop that
dies while the reason is DC_SESSION leaves that reason latched under log-on-change, so the
sample never becomes judgeable at all.

Rules this obeys, and why:
  * rows are grouped by session_id and ordered by `seq`, NEVER by `ts`. One session is one
    boot, and `ts` is comparable only within a boot and only after that boot's clock step
    (docs/ride-log-clock.md; src/db.ts's header: ORDER BY ts is not write order).
  * rows with a NULL session_id or seq are excluded rather than bucketed together — they
    were sealed before 2026-08-16 and carry no order.
  * an interval containing a clock step is REFUSED, not measured (evidence/keyoff/README.md).
"""

import collections
import os
import sqlite3

DB = os.environ.get("RIDES_DB", os.path.expanduser("~/Documents/cool-eva/rides.db"))
# The mutant's magnitude: degrees C added to the curve's input, and percent subtracted from
# the DC arm's answer. A MAGNITUDE, not a flag — BIAS_C=7 is what the committed column is
# taken at, and BIAS_C=1 would be a +1 C mutant rather than that one.
BIAS_C = float(os.environ.get("BIAS_C", 7))
GRACES_MS = [30_000, 20_000, 10_000, 5_000, 3_000, 2_000, 1_000]

# src/fan/control.ts and src/fan/curve.ts. Kept as literals rather than parsed out of the
# TypeScript: a copy that drifts is caught by scripts/check-fan-curve.ts, which pins every
# one of them against the source, and a parser here would be a second thing to be wrong.
MIN_RUNNING, FAN_ON, TOP, MAX_DUTY = 30, 35, 48, 100
REASON_PACK, REASON_DC, MODE_AUTOMATIC, INPUT_LIVE = 5, 8, 1, 0

# A ts jump bigger than this between rows at CONSECUTIVE seq is a clock step, not a wait.
STEP_MS = 20_000

# `fan_duty_pct` is never read below. It is here as a SAMPLING CLOCK: a divergence is only
# ever measured when a judgeable row arrives after it opened, so dropping a key shortens
# every interval that key would have witnessed — without it the archive's longest lag
# (boot 80, 3.2 s) disappears at every grace. It sharpens the SHORT end only: its rows
# exist only when the duty CHANGES, so during a real stall it emits nothing at all, and
# `batt_temp_hi` is the clock that matters at the long end.
KEYS = ["batt_temp_hi", "fan_target_pct", "fan_auto_reason", "fan_temp_input", "fan_auto_mode", "fan_duty_pct"]


def riding_curve_duty(celsius):
    """src/fan/curve.ts's ridingCurveDuty(), which is pure so that it can be replayed."""
    if celsius >= TOP:
        return MAX_DUTY
    if celsius <= FAN_ON:
        return MIN_RUNNING
    span = (celsius - FAN_ON) / (TOP - FAN_ON)
    return round(MIN_RUNNING + span * (MAX_DUTY - MIN_RUNNING))


def load_steps(con):
    """Every real clock step, keyed by the `seq` of the row after the jump.

    ⚠️ Over the WHOLE reading table at contiguous seq. Deriving these from this script's
    own six-key row stream instead reads every quiet sampling gap as a step — batt_temp_hi
    moves every 60-500 s — and refuses the very intervals the detector exists to measure.
    That bug returned ZERO mutation kills at a 30 s grace while looking healthy at 5 s.
    """
    steps = collections.defaultdict(list)
    for session, seq, jump_ms in con.execute(
        """
        WITH x AS (SELECT session_id, seq, ts,
                          LAG(ts)  OVER (PARTITION BY session_id ORDER BY seq) prev_ts,
                          LAG(seq) OVER (PARTITION BY session_id ORDER BY seq) prev_seq
                   FROM reading WHERE session_id IS NOT NULL AND seq IS NOT NULL)
        SELECT session_id, seq, ts - prev_ts FROM x
        WHERE prev_ts IS NOT NULL AND prev_seq = seq - 1 AND ABS(ts - prev_ts) > ?
        """,
        (STEP_MS,),
    ):
        steps[session].append((seq, jump_ms))
    return steps


def load_boots(con, signal_ids, name_of):
    """The six-key row stream, per boot, in write order. Returns (boots, rows dropped)."""
    boots = collections.defaultdict(list)
    dropped = 0
    for session, seq, ts, signal, value in con.execute(
        "SELECT session_id, seq, ts, signal_id, value FROM reading WHERE signal_id IN (%s) "
        "ORDER BY session_id, seq" % ",".join("?" * len(signal_ids)),
        signal_ids,
    ):
        if session is None or seq is None:
            dropped += 1
            continue
        boots[session].append((seq, ts, name_of[signal], value))
    return boots, dropped


def wanted_duty(arm, state, bias_c):
    """What the loop's own rules say the duty should be, or None if this row cannot judge."""
    if state["fan_auto_mode"] != MODE_AUTOMATIC or state["fan_target_pct"] is None:
        return None
    if arm == "curve":
        if (
            state["fan_auto_reason"] == REASON_PACK
            and state["fan_temp_input"] == INPUT_LIVE
            and state["batt_temp_hi"] is not None
        ):
            return riding_curve_duty(state["batt_temp_hi"] + bias_c)
        return None
    if state["fan_auto_reason"] == REASON_DC:
        return MAX_DUTY - bias_c
    return None


def measure(boots, steps, grace_ms, bias_c):
    """Walk every boot and record each divergence that outlived `grace_ms`."""
    stats = {arm: {"samples": 0, "instant": 0, "held": [], "refused": 0, "boots": set()} for arm in ("curve", "dc")}
    for session, events in sorted(boots.items()):
        state = dict.fromkeys(KEYS)
        session_steps = steps.get(session, ())
        open_divergence = {}
        for seq, ts, key, value in events:
            state[key] = value
            for arm in ("curve", "dc"):
                want = wanted_duty(arm, state, bias_c)
                if want is None:
                    open_divergence.pop(arm, None)
                    continue
                arm_stats = stats[arm]
                arm_stats["samples"] += 1
                arm_stats["boots"].add(session)
                if want == state["fan_target_pct"]:
                    open_divergence.pop(arm, None)
                    continue
                arm_stats["instant"] += 1
                if arm not in open_divergence:
                    open_divergence[arm] = (ts, seq, state["batt_temp_hi"], state["fan_target_pct"], want)
                    continue
                started_ts, started_seq, pack, target, wanted = open_divergence[arm]
                # ⚠️ ABOVE the sign check. A backward step is exactly what makes `elapsed`
                # negative, and such an interval is refusable, not fatal — raising first
                # would abort the sweep on the one case the refusal exists for.
                if any(started_seq < step_seq <= seq for step_seq, _ in session_steps):
                    arm_stats["refused"] += 1
                    open_divergence.pop(arm, None)
                    continue
                elapsed = ts - started_ts
                if elapsed < 0:
                    raise SystemExit(
                        f"boot {session}: ts ran backwards inside a divergence with no step to explain it "
                        f"(seq {started_seq}->{seq}) — refusing to call that a duration"
                    )
                if elapsed > grace_ms:
                    arm_stats["held"].append((session, started_seq, seq, elapsed, pack, target, wanted))
                    open_divergence.pop(arm, None)
    return stats


def summarise(stats, arm, grace_ms):
    arm_stats = stats[arm]
    longest = max((finding[3] for finding in arm_stats["held"]), default=0) / 1000
    return f"{len(arm_stats['held']):3d} held (longest {longest:7.1f}s), {arm_stats['refused']:3d} refused"


def main():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    ids = dict(con.execute("SELECT key, id FROM signal WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS))
    name_of = {value: key for key, value in ids.items()}
    readings, sessions = con.execute("SELECT (SELECT COUNT(*) FROM reading), (SELECT COUNT(*) FROM session)").fetchone()

    steps = load_steps(con)
    boots, dropped = load_boots(con, list(ids.values()), name_of)
    total_steps = sum(len(found) for found in steps.values())
    backward = sum(1 for found in steps.values() for _, jump in found if jump < 0)

    print("# Generated by curve-lag.py — see README.md.")
    print("# Every figure in docs/fan-control.md §9 and the cross-boot section of")
    print("# docs/ride-log-clock.md comes from here.")
    print(f"# Corpus: rides.db of 2026-09-18 — {readings} readings across {sessions} sessions.")
    print(f"# ⚠️ docs/ride-log-clock.md §1 quotes the same file at 2026-09-13 (35 168 921 readings,")
    print(f"# 130 boots). Two snapshots of one growing archive; neither supersedes the other.")
    print()
    print(f"clock steps over the full table: {total_steps} in {len(steps)} sessions ({backward} backward)")
    print(f"boots carrying any of the {len(KEYS)} keys: {len(boots)}  (rows dropped for a NULL session_id or seq: {dropped})")

    baseline = measure(boots, steps, GRACES_MS[0], 0)
    judging = baseline["curve"]["boots"] | baseline["dc"]["boots"]
    dc_only = baseline["dc"]["boots"] - baseline["curve"]["boots"]
    print(
        f"boots contributing a judgeable sample: {len(judging)} = {len(baseline['curve']['boots'])} curve "
        f"+ {len(baseline['dc']['boots'])} dc ({len(dc_only)} dc-only)"
    )
    print(f"curve arm: {baseline['curve']['samples']} samples, {baseline['curve']['instant']} disagree at the instant sampled")
    print(f"dc    arm: {baseline['dc']['samples']} samples, {baseline['dc']['instant']} disagree at the instant sampled")

    print("\n--- how long a disagreement was ever HELD ---")
    print(f"{'grace':>6} | {'real archive':^47} | {'mutant +' + format(BIAS_C, 'g'):^47}")
    print(f"{'':>6} | {'curve':^23} {'dc':^23} | {'curve':^23} {'dc':^23}")
    for grace in GRACES_MS:
        real = measure(boots, steps, grace, 0)
        mutant = measure(boots, steps, grace, BIAS_C)
        print(
            f"{grace / 1000:5.0f}s | {summarise(real, 'curve', grace)} {summarise(real, 'dc', grace)} | "
            f"{summarise(mutant, 'curve', grace)} {summarise(mutant, 'dc', grace)}"
        )

    print("\n--- every divergence the real archive ever held, at the tightest grace ---")
    tightest = measure(boots, steps, min(GRACES_MS), 0)
    for arm in ("curve", "dc"):
        for session, from_seq, to_seq, held, pack, target, want in tightest[arm]["held"]:
            print(
                f"  {arm:5s} boot {session}: seq {from_seq}->{to_seq}, held {held / 1000:.1f}s, "
                f"pack {pack} C, target {target}%, wanted {want}%"
            )

    print(f"\n--- the 2026-09-09 DC charge (boot 80) under the mutant, {GRACES_MS[0] / 1000:.0f} s grace ---")
    mutated = measure(boots, steps, GRACES_MS[0], BIAS_C)
    boot80 = [finding for finding in mutated["dc"]["held"] if finding[0] == 80]
    print(f"  {len(boot80)} findings, durations {sorted(round(finding[3] / 1000) for finding in boot80)} s")


main()
