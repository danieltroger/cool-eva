"""Every rides.db figure in docs/ride-log-clock.md and docs/power-cuts.md §7.

    python3 clock-figures.py <a READ-ONLY copy of rides.db>

⚠️ Opens the file `immutable=1`. Never point this at the working rides.db: a plain open
creates -wal/-shm siblings beside it, and `?mode=ro` fails on a chmod-444 copy.
"""

import sqlite3
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone

#: A jump this size between consecutive `seq` is a clock step rather than drift.
STEP_THRESHOLD_MS = 60_000
#: The ride log's segment timer. A wrong date only reaches a FILE NAME if a seal fired.
SEGMENT_INTERVAL_MS = 30_000
#: How close a GPS-recovered offset must land to count as corroborating the step.
#: ⚠️ A real bound, compared against: the line used to print "N of N within 1.54 s" with the
#: same count on both sides, so it would have said that with a 900-second error.
OFFSET_AGREEMENT_S = 1.54
#: Readings after a key_on edge past which the bus plainly did not stop.
STILL_RUNNING_READINGS = 200


def main(path):
    db = sqlite3.connect(f"file:{path}?immutable=1", uri=True)
    say(f"readings {one(db, 'SELECT COUNT(*) FROM reading')}, "
        f"sessions {one(db, 'SELECT COUNT(DISTINCT session_id) FROM reading WHERE session_id IS NOT NULL')}")
    report_key_off(db)
    report_rail(db)
    report_parks(db)
    steps = report_steps(db)
    report_redating(db, steps)
    report_unclocked(db)
    report_boot_file_cost(db)


def report_key_off(db):
    say("\nkey_on and vcu_12v_power_good — the two docs/power-cuts.md §2 claims")
    for key in ("key_on", "vcu_12v_power_good"):
        rows = db.execute(
            "SELECT r.value, COUNT(*) FROM reading r JOIN signal s ON s.id = r.signal_id "
            "WHERE s.key = ? GROUP BY r.value ORDER BY r.value", (key,)).fetchall()
        say(f"  {key}: " + ", ".join(f"{value:g} -> {count}" for value, count in rows))
    edges = db.execute(
        "WITH k AS (SELECT r.session_id sid, r.seq, r.value, "
        "  LAG(r.value) OVER (PARTITION BY r.session_id ORDER BY r.seq) prev "
        "  FROM reading r JOIN signal s ON s.id = r.signal_id "
        "  WHERE s.key = 'key_on' AND r.session_id IS NOT NULL) "
        "SELECT sid, seq FROM k WHERE value = 0 AND prev = 1").fetchall()
    followed = []
    for sid, seq in edges:
        followed.append(one(db, "SELECT COUNT(*) FROM reading WHERE session_id = ? AND seq > ?", (sid, seq)))
    survivors = [count for count in followed if count > STILL_RUNNING_READINGS]
    if not survivors:
        say(f"  1->0 edges {len(edges)}; none followed by more than {STILL_RUNNING_READINGS} readings")
        return
    say(f"  1->0 edges {len(edges)} across {len({sid for sid, _ in edges})} sessions; "
        f"{len(survivors)} of them followed by more than {STILL_RUNNING_READINGS} further readings "
        f"({min(survivors)}-{max(survivors)}) — i.e. the bus plainly did not stop")


def report_rail(db):
    rows = db.execute(
        "WITH p AS (SELECT r.session_id sid, r.seq, r.value FROM reading r JOIN signal s ON s.id = r.signal_id "
        "  WHERE s.key = 'psu_12v_mv' AND r.session_id IS NOT NULL), "
        "  last AS (SELECT sid, MAX(seq) seq FROM p GROUP BY sid) "
        "SELECT p.value FROM last JOIN p ON p.sid = last.sid AND p.seq = last.seq").fetchall()
    values = [value for (value,) in rows]
    say(f"\npsu_12v_mv: {len(values)} sessions carry it; last reading {min(values):g}-{max(values):g} mV "
        f"— the rail does not sag, it stops")


def report_parks(db):
    # BLE `vehicle_state`, which is sparse: 0x101 at 100 Hz catches every park and this
    # under-counts. Observed transitions only — `prev IS NULL` is a session's first row,
    # not an entry, and counting it is the same contamination the capture side had.
    rows = db.execute(
        "WITH v AS (SELECT r.session_id sid, r.seq, r.ts, r.value, "
        "  LAG(r.value) OVER (PARTITION BY r.session_id ORDER BY r.seq) prev "
        "  FROM reading r JOIN signal s ON s.id = r.signal_id "
        "  WHERE s.key = 'vehicle_state' AND r.session_id IS NOT NULL) "
        "SELECT sid, seq, ts FROM v WHERE value = 60 AND prev IS NOT NULL AND prev <> 60").fetchall()
    last_per_session = {}
    for sid, seq, ts in rows:
        if sid not in last_per_session or seq > last_per_session[sid][0]:
            last_per_session[sid] = (seq, ts)
    # ⚠️ A wall-clock window, in the one analysis that exists because wall-clock differences
    # are not durations here. So a session whose clock JUMPS inside the window is refused
    # rather than counted: the window would otherwise span the step and count a whole session.
    protected = []
    refused = 0
    for sid, (_, ts) in last_per_session.items():
        jumped = one(db,
                     "SELECT COUNT(*) FROM (SELECT ts - LAG(ts) OVER (ORDER BY seq) dt FROM reading "
                     "WHERE session_id = ? AND ts BETWEEN ? AND ?) WHERE dt > ? OR dt < ?",
                     (sid, ts - SEGMENT_INTERVAL_MS, ts, STEP_THRESHOLD_MS, -STEP_THRESHOLD_MS))
        if jumped:
            refused += 1
            continue
        protected.append(one(db, "SELECT COUNT(*) FROM reading WHERE session_id = ? AND ts BETWEEN ? AND ?",
                             (sid, ts - SEGMENT_INTERVAL_MS, ts)))
    say(f"\npark entries (BLE vehicle_state, observed transitions) {len(rows)} across {len(last_per_session)} sessions")
    say(f"  readings in the {SEGMENT_INTERVAL_MS // 1000} s before the LAST park of each session: "
        f"min {min(protected)} median {statistics.median(protected):g} max {max(protected)}, total {sum(protected)}"
        f" (over {len(protected)} sessions; {refused} refused for a clock jump inside the window)")


def report_steps(db):
    jumps = defaultdict(list)
    for sid, seq, ts, delta in db.execute(
            "WITH d AS (SELECT session_id sid, seq, ts, "
            "  ts - LAG(ts) OVER (PARTITION BY session_id ORDER BY seq) dt "
            "  FROM reading WHERE session_id IS NOT NULL) "
            "SELECT sid, seq, ts, dt FROM d WHERE dt > ? OR dt < ? ORDER BY sid, seq",
            (STEP_THRESHOLD_MS, -STEP_THRESHOLD_MS)):
        jumps[sid].append((seq, ts, delta))
    first = {sid: min(rows) for sid, rows in jumps.items()}
    windows, pre_rows, crossing = [], 0, []
    for sid, (seq, ts, delta) in first.items():
        start_seq, start_ts = db.execute(
            "SELECT MIN(seq), MIN(ts) FROM reading WHERE session_id = ? AND seq = "
            "(SELECT MIN(seq) FROM reading WHERE session_id = ?)", (sid, sid)).fetchone()
        window = (ts - delta - start_ts) / 1000
        windows.append((window, sid))
        pre_rows += one(db, "SELECT COUNT(*) FROM reading WHERE session_id = ? AND seq < ?", (sid, seq))
        if day(ts - delta) != day(ts):
            crossing.append((sid, window))
    windows.sort()
    say(f"\nclock steps: {len(jumps)} sessions carry a >{STEP_THRESHOLD_MS // 1000} s jump; "
        f"{sum(1 for rows in jumps.values() if len(rows) == 1)} carry exactly one")
    say(f"  ⚠️ a jump this size is also what log-on-change produces on a quiet bus, so this is an "
        f"upper bound; the GPS-corroborated subset below is the floor")
    say(f"  window to the FIRST jump: min {windows[0][0]:.1f} median "
        f"{statistics.median(w for w, _ in windows):.1f} max {windows[-1][0]:.1f} s (session {windows[-1][1]})")
    say(f"  readings stamped before it: {pre_rows}")
    sealed = [row for row in crossing if row[1] * 1000 >= SEGMENT_INTERVAL_MS]
    say(f"  pre-step rows crossing a date boundary: {len(crossing)} sessions; of those with a window "
        f"past the seal interval, so a FILE really got the wrong name: {len(sealed)}")
    return first


def report_redating(db, first_jumps):
    signal = one(db, "SELECT id FROM signal WHERE key = 'gps_epoch_s'")
    errors, windows = [], []
    for sid, (seq, ts, delta) in first_jumps.items():
        row = db.execute(
            "SELECT ts, value FROM reading WHERE session_id = ? AND signal_id = ? AND seq < ? "
            "ORDER BY seq DESC LIMIT 1", (sid, signal, seq)).fetchone()
        if row is None:
            continue
        errors.append(abs((row[1] * 1000 - row[0]) - delta) / 1000)
        start_ts = one(db, "SELECT MIN(ts) FROM reading WHERE session_id = ? AND seq = "
                           "(SELECT MIN(seq) FROM reading WHERE session_id = ?)", (sid, sid))
        windows.append((ts - delta - start_ts) / 1000)
    say(f"\nre-dating from gps_epoch_s: {len(errors)} stepped sessions carry a pre-step GPS row")
    agreeing = sum(1 for error in errors if error <= OFFSET_AGREEMENT_S)
    say(f"  recovered offset vs the measured step: min {min(errors):.3f} median "
        f"{statistics.median(errors):.3f} max {max(errors):.3f} s")
    say(f"  within {OFFSET_AGREEMENT_S} s: {agreeing} of {len(errors)}")
    say(f"  window over that corroborated subset: median {statistics.median(windows):.1f} s, "
        f"{sum(1 for w in windows if w * 1000 > SEGMENT_INTERVAL_MS)} of {len(windows)} past the seal interval")


def report_unclocked(db):
    rows = db.execute(
        "WITH g AS (SELECT r.session_id sid, COUNT(*) n FROM reading r JOIN signal s ON s.id = r.signal_id "
        "  WHERE s.key = 'gps_epoch_s' AND r.session_id IS NOT NULL GROUP BY r.session_id), "
        "  b AS (SELECT session_id sid, COUNT(*) rows FROM reading WHERE session_id IS NOT NULL GROUP BY session_id) "
        "SELECT b.rows FROM b LEFT JOIN g ON g.sid = b.sid WHERE g.n IS NULL").fetchall()
    sizes = sorted(rows for (rows,) in rows)
    say(f"\nsessions that never log a GPS fix: {len(sizes)}, holding {sum(sizes)} readings "
        f"(median {statistics.median(sizes):g}, max {max(sizes)})")
    say("  these never reach satellite-backed, so their WHOLE session is written under a boot name")


def report_boot_file_cost(db):
    """What the boot-named files cost, which docs/ride-log-clock.md §2 quotes as a table."""
    sessions = db.execute(
        "SELECT session_id, COUNT(*) FROM reading WHERE session_id IS NOT NULL GROUP BY session_id").fetchall()
    unclocked = {
        sid for (sid,) in db.execute(
            "SELECT b.sid FROM (SELECT session_id sid FROM reading WHERE session_id IS NOT NULL GROUP BY session_id) b "
            "LEFT JOIN (SELECT r.session_id sid FROM reading r JOIN signal s ON s.id = r.signal_id "
            "  WHERE s.key = 'gps_epoch_s' AND r.session_id IS NOT NULL GROUP BY r.session_id) g ON g.sid = b.sid "
            "WHERE g.sid IS NULL")
    }
    span_ms = one(db, "SELECT MAX(ts) - MIN(ts) FROM reading WHERE ts < 4000000000000 AND session_id IS NOT NULL")
    days = span_ms / 86_400_000
    total = sum(count for _, count in sessions)
    # A GPS-less session puts its WHOLE content in the boot file; a stepped one puts the rows
    # before the step there. Everything else contributes only its first few seconds.
    in_boot_files = sum(count for sid, count in sessions if sid in unclocked)
    say(f"\nboot-named files: {len(sessions)} boots over {days:.1f} days = {len(sessions) / days:.2f} a day "
        f"({len(sessions) / days * 365:.0f} a year), one per boot")
    say(f"  readings landing in them from GPS-less boots alone: {in_boot_files} of {total} "
        f"({100 * in_boot_files / total:.1f} %), before the pre-step rows of the boots that do sync")


def day(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).strftime("%Y-%m-%d")


def one(db, sql, arguments=()):
    return db.execute(sql, arguments).fetchone()[0]


def say(text):
    print(text)


main(sys.argv[1])
