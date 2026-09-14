"""Every capture-derived figure in docs/power-cuts.md §7, generated from the reduction.

    python3 capture-figures.py events.txt tails.jsonl

A boot's LAST capture is the one that ended when the Pi did; every earlier file of the same
boot id ended because candump restarted while the Pi was alive (pre-`-D`, #185). Only those
"terminal" captures can measure how much warning the bus gives.
"""

import json
import re
import statistics
import sys
from datetime import datetime

# Both name shapes. The trailing `-<uptime>` group arrived with #188; without the optional
# group every capture written from that deploy on would `continue` out of the boot census
# silently, shrinking the corpus with no error — this script would be invalidated by the
# other half of the PR that introduced it.
NAME = re.compile(r"capture-(\d{8})-(\d{6})-([0-9a-f]{8})(?:-(\d+))?\.log$")
MINIMUM_FRAMES = 1000
#: A backward step under this is candump's own sub-second reordering, not a clock move.
REORDER_TOLERANCE_SECONDS = 0.25


def main(events_path, tails_path):
    captures = load(events_path, tails_path)
    alive = [capture for capture in captures if capture["frames"] > 0]
    say("Corpus")
    say(f"  files reduced {len(captures)}, carrying frames {len(alive)}")
    say(f"  carrying a 0x101 change {sum(1 for c in alive if c['states'])}, "
        f"a 0x102 b1 change {sum(1 for c in alive if c['vehicleBytes'])}")
    report_endings(captures)

    terminal, boots = terminal_captures(captures)
    say("Boots")
    say(f"  distinct boot ids {boots}, terminal captures carrying >{MINIMUM_FRAMES} frames {len(terminal)}")
    report_parks(terminal)
    report_coverage(terminal)
    report_fault_state(terminal)
    report_key_off(alive, terminal)
    report_shutdown_walks(terminal)
    report_name_order(captures)
    report_corpus_dates(terminal)


def report_endings(captures):
    non_empty = [c for c in captures if c["tail"]["size"] > 0]
    aligned = [c for c in non_empty if c["tail"]["size"] % 4096 == 0]
    holed = [c for c in non_empty if c["tail"]["nulls"] > 0]
    say("How a capture ends")
    say(f"  non-empty {len(non_empty)}, ending exactly on a 4096-byte boundary {len(aligned)} "
        f"(of those, mid-line {sum(1 for c in aligned if not c['tail']['endsWithNewline'])})")
    say(f"  carrying a trailing NUL run {len(holed)}, lengths "
        f"{min(c['tail']['nulls'] for c in holed)}-{max(c['tail']['nulls'] for c in holed)} bytes")


def report_parks(terminal):
    # Split on whether the entry was OBSERVED. A file whose first 0x101 frame already reads
    # 60 opened with the bike parked: its "lead" is the file's length, not a measurement.
    observed, opened_parked, refused = [], [], 0
    for capture in terminal:
        entry = last_entry_into(capture, {60})
        if entry is None:
            continue
        when, state, substate, was_first = entry
        if spans_a_gap(capture, when, capture["last"]):
            refused += 1
            continue
        row = (capture["last"] - when, f"{state}/{substate}", capture["path"])
        (opened_parked if was_first else observed).append(row)
    say("Park entry to the last frame of the boot")
    describe("  observed entries", observed)
    describe("  opened already parked (file lengths, NOT park measurements)", opened_parked)
    say(f"  refused for a discontinuity {refused}")
    leads = sorted(lead for lead, _, _ in observed)
    say(f"  observed entries under 30 s: {sum(1 for lead in leads if lead < 30)}; under 10 s: "
        f"{sum(1 for lead in leads if lead < 10)}")
    # The check that makes the lower bound safe: the gap rule is not hiding a short lead.
    smallest = smallest_refused_lead(terminal, {60})
    say(f"  smallest RAW lead among the refused {smallest:.2f} s — so nothing under 10 s is filtered out")


def report_name_order(captures):
    """Does sorting a boot's files by the name's DATE agree with their own first frames?

    This is the whole justification for keeping the date first in the capture filename rather
    than leading with the boot id, and it was asserted in three places with nothing behind it.
    """
    boots = {}
    for capture in captures:
        match = NAME.match(capture["path"])
        if not match or capture["frames"] == 0:
            continue
        boots.setdefault(match.group(3), []).append((match.group(1) + match.group(2), capture["first"]))
    comparable = {boot: files for boot, files in boots.items() if len(files) > 1}
    disagreeing = []
    for boot, files in comparable.items():
        by_name = [first for _, first in sorted(files)]
        if by_name != sorted(by_name):
            disagreeing.append(boot)
    say("Does the name's date order a boot's files the way their own frames do?")
    say(f"  boots in the archive {len(boots)}, of which more than one frame-carrying file {len(comparable)}")
    say(f"  boots where the two orders DISAGREE: {len(disagreeing)} {disagreeing}")


def report_corpus_dates(terminal):
    """How narrow the corpus is. A figure the docs quote as a caveat, so it has to be real."""
    days = {}
    for capture in terminal:
        match = NAME.match(capture["path"])
        if match:
            days[match.group(1)] = days.get(match.group(1), 0) + 1
    ordered = sorted(days.items())
    august = sum(count for day, count in ordered if "20260802" <= day <= "20260810")
    say("Corpus spread of the terminal captures")
    say(f"  {august} of {len(terminal)} fall in 2026-08-02..08-10; busiest single day "
        f"{max(days.values())} captures")
    say("  " + ", ".join(f"{day}: {count}" for day, count in ordered))


def report_coverage(terminal):
    census = {}
    for capture in terminal:
        final = capture["states"][-1][2] if capture["states"] else None
        census[final] = census.get(final, 0) + 1
    never = sum(1 for c in terminal if not any(state == 60 for _, _, state, _ in c["states"]))
    say("Coverage — last 0x101 state of each terminal capture")
    say("  " + ", ".join(f"{state}: {count}" for state, count in sorted(census.items(), key=str)))
    say(f"  never showing state 60 at all {never} of {len(terminal)}")


def report_fault_state(terminal):
    leads = []
    for capture in terminal:
        entry = last_entry_into(capture, {80})
        if entry is None or entry[3]:
            continue
        when = entry[0]
        if spans_a_gap(capture, when, capture["last"]):
            continue
        leads.append((capture["last"] - when, entry[1], capture["path"]))
    say("Entry into state 80 (blocking fault) to the last frame — measured, and rejected as a trigger")
    describe("  observed entries", leads)
    say(f"  under 11 s: {sum(1 for lead, _, _ in leads if lead < 11)} of {len(leads)}")


def report_key_off(alive, terminal):
    edges = changes = opened_clear = 0
    edge_files = change_files = 0
    for capture in alive:
        file_edges = file_changes = 0
        previous = None
        for index, (_, byte1, _) in enumerate(capture["vehicleBytes"]):
            current = (byte1 >> 4) & 1
            if index == 0:
                opened_clear += 1 if current == 0 else 0
            else:
                file_changes += 1 if current == 0 else 0
                file_edges += 1 if previous == 1 and current == 0 else 0
            previous = current
        edges += file_edges
        changes += file_changes
        edge_files += 1 if file_edges else 0
        change_files += 1 if file_changes else 0
    say("key_on — 0x102 b1 bit 4")
    say(f"  files whose FIRST observation already had it clear {opened_clear} "
        f"(evidence the bit reads 0, NOT evidence of a change)")
    say(f"  changes TO a clear value {changes} across {change_files} files")
    say(f"  genuine 1->0 edges {edges} across {edge_files} files")
    leads = []
    for capture in terminal:
        edge = last_key_off(capture)
        if edge is None:
            continue
        if spans_a_gap(capture, edge, capture["last"]):
            leads.append(None)
            continue
        leads.append(capture["last"] - edge)
    measured = sorted(lead for lead in leads if lead is not None)
    say(f"  terminal captures carrying an edge {len(leads)}, gap-free {len(measured)}, "
        f"lead {measured[0]:.3f}-{measured[-1]:.1f} s")


def report_shutdown_walks(terminal):
    say("Shutdown walks — captures entering state 1 or 20 within their last 60 s")
    for capture in terminal:
        entry = last_entry_into(capture, {1, 20})
        if entry is None or entry[3]:
            continue
        when = entry[0]
        if spans_a_gap(capture, when, capture["last"]) or capture["last"] - when > 60:
            continue
        last_when, last_substate, last_state, _ = capture["states"][-1]
        chain = " -> ".join(
            f"{state}/{substate}"
            for moment, substate, state, _ in capture["states"]
            if moment >= when - 30
        )
        say(f"  entered {entry[1]}/{entry[2]} at -{capture['last'] - when:.2f} s; "
            f"last 0x101 SUBSTATE change {last_state}/{last_substate} at "
            f"-{capture['last'] - last_when:.3f} s   {capture['path']}")
        say(f"      chain: {chain}")


def describe(label, rows):
    if not rows:
        say(f"{label}: none")
        return
    leads = sorted(lead for lead, _, _ in rows)
    substates = sorted({substate for _, substate, _ in rows})
    say(f"{label}: n={len(rows)} min {leads[0]:.2f} median {statistics.median(leads):.2f} "
        f"max {leads[-1]:.2f} s, substates {substates}")


def last_entry_into(capture, states):
    """Last transition into one of `states`, and whether it was the file's FIRST 0x101 frame.

    That flag is the whole point: without it a capture that opened with the bike already in
    the state scores as a transition into it, and its file length is reported as a lead.
    """
    previous = None
    found = None
    for index, (when, substate, state, _) in enumerate(capture["states"]):
        if state in states and previous not in states:
            found = (when, state, substate, index == 0)
        previous = state
    return found


def last_key_off(capture):
    previous = None
    found = None
    for when, byte1, _ in capture["vehicleBytes"]:
        current = (byte1 >> 4) & 1
        if previous == 1 and current == 0:
            found = when
        previous = current
    return found


def smallest_refused_lead(terminal, states):
    raw = []
    for capture in terminal:
        entry = last_entry_into(capture, states)
        if entry is None or not spans_a_gap(capture, entry[0], capture["last"]):
            continue
        lead = capture["last"] - entry[0]
        if lead > 0:
            raw.append(lead)
    return min(raw) if raw else float("nan")


def real_gaps(capture):
    return [
        (before, after, index)
        for before, after, index in capture["gaps"]
        if after - before > 1.0 or after - before < -REORDER_TOLERANCE_SECONDS
    ]


def spans_a_gap(capture, start, end):
    # ⚠️ A backward step puts `end` before `start`. An inverted range matches nothing, so
    # without this the guard silently passes the single worst interval in the corpus — the
    # 2060-dated capture, whose "lead" comes out at -1.07e9 s.
    if end < start:
        return True
    return any(start < before < end or start < after < end for before, after, _ in real_gaps(capture))


def terminal_captures(captures):
    boots = {}
    for capture in captures:
        match = NAME.match(capture["path"])
        if not match:
            continue
        capture["nameStamp"] = match.group(1) + match.group(2)
        boots.setdefault(match.group(3), []).append(capture)
    terminal = []
    for files in boots.values():
        files.sort(key=lambda capture: capture["nameStamp"])
        if files[-1]["frames"] > MINIMUM_FRAMES:
            terminal.append(files[-1])
    terminal.sort(key=lambda capture: capture["nameStamp"])
    return terminal, len(boots)


def stamp(text):
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S.%f").timestamp()


def load(events_path, tails_path):
    captures = []
    current = None
    for line in open(events_path):
        parts = line.split()
        if not parts:
            continue
        kind = parts[0]
        if kind == "F":
            current = {"path": parts[1], "states": [], "vehicleBytes": [], "gaps": [],
                       "frames": 0, "first": None, "last": None}
            captures.append(current)
        elif current is None:
            continue
        elif kind == "S101" and len(parts) >= 6:
            current["states"].append((stamp(parts[1] + " " + parts[2]), int(parts[3], 16),
                                      int(parts[4], 16), int(parts[5])))
        elif kind == "B102" and len(parts) >= 5:
            current["vehicleBytes"].append((stamp(parts[1] + " " + parts[2]), int(parts[3], 16), int(parts[4])))
        elif kind == "GAP" and len(parts) >= 6:
            current["gaps"].append((stamp(parts[1] + " " + parts[2]), stamp(parts[3] + " " + parts[4]), int(parts[5])))
        elif kind == "FIRST" and len(parts) >= 3:
            current["first"] = stamp(parts[1] + " " + parts[2])
        elif kind == "LAST" and len(parts) >= 3:
            current["last"] = stamp(parts[1] + " " + parts[2])
        elif kind == "FRAMES" and len(parts) >= 2:
            current["frames"] = int(parts[1])
    tails = {json.loads(line)["path"]: json.loads(line) for line in open(tails_path)}
    for capture in captures:
        capture["tail"] = tails.get(capture["path"], {"size": 0, "nulls": 0, "endsWithNewline": None})
    return captures


def say(text):
    print(text)


main(sys.argv[1], sys.argv[2])
