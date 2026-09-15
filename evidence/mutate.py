"""Mutation harness: break one thing, confirm the check that polices it fails.

    python3 evidence/mutate.py

Every patch asserts its target text was present AND how many times, so a mutation that
silently no-ops after a reformat is reported as a broken harness rather than as a surviving
mutant. Two of the first run's three "survivors" were exactly that: a floor and a ratio that
the despiker ANDs, mutated on one side only.

⚠️ IT RESTORES WITH `git checkout -- <path>`, i.e. to HEAD. Run it against a dirty tree and it
deletes the uncommitted change you are testing. Commit first.

The pre-change dashboard comes from the branch point rather than from a file beside this one,
so M8 stays reproducible from a clone.
"""
import json
import subprocess
import sys

MUTANTS = [
    # (id, description, file, old, new, check script)
    ("M1", "despiker floor removed (both terms, 0.000004 -> 0)", "scripts/route-track.ts",
     "> 0.000004", "> 0", "scripts/check-route-track.ts", 2),
    ("M2", "despiker ratio 25 -> 1e30 (both terms, never fires)", "scripts/route-track.ts",
     "> 25 * (dlat_span * dlat_span + dlon_span * dlon_span)",
     "> 1e30 * (dlat_span * dlat_span + dlon_span * dlon_span)", "scripts/check-route-track.ts", 2),
    ("M3", "2060 guard removed", "scripts/route-track.ts",
     "    AND r.ts < 2000000000000\n", "\n", "scripts/check-route-track.ts"),
    ("M4", "per-second collapse disabled (rn = 1 -> rn >= 1)", "scripts/route-track.ts",
     ") WHERE rn = 1", ") WHERE rn >= 1", "scripts/check-route-track.ts"),
    ("M5", "unique index on ts/1000 dropped", "scripts/route-track.ts",
     "    db.exec(CREATE_SECOND_INDEX_SQL);\n", "", "scripts/check-route-track.ts"),
    ("M6", "speed gate re-hardcoded and widened, instead of reading the declared bound",
     "scripts/route-track.ts",
     "BETWEEN ${SPEED_MIN} AND ${SPEED_MAX}", "BETWEEN ${SPEED_MIN} AND 3000",
     "scripts/check-route-track.ts"),
    ("M7", "carry-forward replaced by an inner join on equal ts", "scripts/route-track.ts",
     "JOIN raw lo ON lo.ts = h.lon_ts", "JOIN raw lo ON lo.ts = h.ts AND lo.lon IS NOT NULL",
     "scripts/check-route-track.ts"),
    ("M9", "info.route_track_built_at no longer written", "scripts/route-track.ts",
     '    db.prepare(\n      "INSERT INTO info (key, value, ts) VALUES (?, ?, ?) " +',
     '    db.prepare(\n      "SELECT ? AS a, ? AS b, ? AS c -- " +', "scripts/check-route-track.ts"),
    ("M10", "thinning stride loses its ceiling division", "grafana/dashboards/route-map.json",
     "(total + 11999) / 12000", "(total) / 12000", "scripts/check-route-track.ts", 4),
    ("M11", "the window predicate dropped from the panel", "grafana/dashboards/route-map.json",
     "WHERE ts >= $__from AND ts <= $__to", "WHERE ts >= 0 AND ts <= 9999999999999",
     "scripts/check-route-track.ts", 4),
    ("N9", "siblings only moved when <out> itself exists (the orphan-WAL blocker)",
     "scripts/ride-import.ts",
     "  const outSiblings = await siblingsOf(options.outPath);",
     "  const outSiblings = outDbPresent ? await siblingsOf(options.outPath) : [];",
     "scripts/check-import-ride-log.ts"),
    ("N10", "sibling renames made mandatory, so a vanished -wal aborts the swap",
     "scripts/ride-import.ts",
     "moves.push({ from: `${outPath}${suffix}`, to: `${asidePath}${suffix}`, optional: true });",
     "moves.push({ from: `${outPath}${suffix}`, to: `${asidePath}${suffix}`, optional: false });",
     "scripts/check-import-ride-log.ts"),
    ("N1", "decrypt exit 2 treated as fatal", "scripts/ride-import.ts",
     "if (decryptCode !== 0 && decryptCode !== 2) {", "if (decryptCode !== 0) {",
     "scripts/check-import-ride-log.ts"),
    ("N2", "a failed recovery commit falls through to the swap", "scripts/ride-import.ts",
     '(stranded.length > 0 ? `, and its backup ${stranded.join(", ")} removed` : "");\n    return outcome;',
     '(stranded.length > 0 ? `, and its backup ${stranded.join(", ")} removed` : "");',
     "scripts/check-import-ride-log.ts"),
    ("N3", "-wal/-shm siblings left behind by the swap", "scripts/ride-import.ts",
     "    for (const suffix of present.outSiblings) {",
     "    for (const suffix of []) {",
     "scripts/check-import-ride-log.ts"),
    ("N4", "non-empty <out>-wal no longer refuses", "scripts/ride-import.ts",
     "if (walBytes !== null && walBytes > 0) {", "if (walBytes === null && walBytes !== null) {",
     "scripts/check-import-ride-log.ts"),
    ("N5", "coverage guard always passes", "scripts/ride-import.ts",
     "  if (allowShrink) {\n    return null;\n  }", "  if (allowShrink || true) {\n    return null;\n  }",
     "scripts/check-import-ride-log.ts"),
    ("N6", "the recovery's staging backup is left on disk", "scripts/ride-import.ts",
     "  await removeRecoveryBackups(stagingPath);\n", "", "scripts/check-import-ride-log.ts"),
    ("N7", "a leftover staging file no longer stops the next import", "scripts/ride-import.ts",
     "if (orphanedStaging.length > 0) {", "if (orphanedStaging.length > 1000) {",
     "scripts/check-import-ride-log.ts"),
    ("N8", "journal_mode left in WAL", "scripts/route-track.ts",
     'journalMode: String(db.pragma("journal_mode = DELETE", { simple: true }))',
     'journalMode: String(db.pragma("journal_mode", { simple: true }))',
     "scripts/check-import-ride-log.ts"),
]


def run(check):
    done = subprocess.run(["node", "--experimental-strip-types", check], capture_output=True, text=True)
    return done.returncode


def restore(*paths):
    subprocess.run(["git", "checkout", "--", *paths], check=True)


def apply_text(path, old, new, occurrences=1):
    text = open(path).read()
    assert old in text, f"MUTATION TARGET NOT FOUND in {path}: {old[:60]!r}"
    found = text.count(old)
    assert found == occurrences, f"expected {occurrences} of {old[:60]!r} in {path}, found {found}"
    open(path, "w").write(text.replace(old, new))


BRANCH_POINT = "ff47c4a"  # where this branch left main; the dashboard there still rebuilds the track


def mutate_dashboard_to_old_pipeline():
    shipped = subprocess.run(
        ["git", "show", f"{BRANCH_POINT}:grafana/dashboards/route-map.json"],
        capture_output=True, text=True, check=True,
    ).stdout
    before = json.loads(shipped)
    now = json.load(open("grafana/dashboards/route-map.json"))
    old = {t["refId"]: t["rawQueryText"] for p in before["panels"] for t in p.get("targets", [])}
    patched = 0
    for panel in now["panels"]:
        for target in panel.get("targets", []):
            if target.get("refId") in ("A", "F"):
                target["rawQueryText"] = old[target["refId"]]
                target["queryText"] = old[target["refId"]]
                patched += 1
    assert patched == 2, patched
    with open("grafana/dashboards/route-map.json", "w") as handle:
        json.dump(now, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


results = []
for entry in MUTANTS:
    mutant, description, path, old, new, check = entry[:6]
    occurrences = entry[6] if len(entry) > 6 else 1
    apply_text(path, old, new, occurrences)
    code = run(check)
    restore(path)
    results.append((mutant, description, check, code))
    print(f"{mutant}  exit {code}  {'KILLED ' if code != 0 else 'SURVIVED'}  {description}", flush=True)

# M8 is the one that matters most: the panel put back to rebuilding from `reading`.
mutate_dashboard_to_old_pipeline()
code = run("scripts/check-route-track.ts")
restore("grafana/dashboards/route-map.json")
results.append(("M8", "dashboard A/F put back to the six-CTE pipeline over `reading`", "scripts/check-route-track.ts", code))
print(f"M8  exit {code}  {'KILLED ' if code != 0 else 'SURVIVED'}  dashboard A/F back to the old pipeline", flush=True)

survived = [r for r in results if r[3] == 0]
print(f"\n{len(results) - len(survived)} of {len(results)} mutants killed")
if survived:
    print("SURVIVORS:")
    for mutant, description, check, _ in survived:
        print(f"  {mutant}  {description}  ({check})")
sys.exit(1 if survived else 0)
