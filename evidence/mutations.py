import subprocess, sys, json
# Each mutation: (label, file, find, replace, check script, which assertion should go red)
M = [
 ("R2 dedupe key ignores the directory", "src/vcu/write-audit.ts",
  '  const key = `${directory}|${lineNumber}|${length}|${kind}`;',
  '  const key = `${lineNumber}|${length}|${kind}`;',
  "scripts/check-write-audit.ts"),
 ("R3 reader switches on any NUL, not a leading run", "src/vcu/write-audit.ts",
  '  const run = /^\\0+/.exec(line);\n  return run ? run[0].length : 0;',
  '  const run = /\\0+/.exec(line);\n  return run ? (run.index === 0 ? run[0].length : line.indexOf("\\0") + run[0].length) : 0;',
  "scripts/check-write-audit.ts"),
 ("#189 the recovered tail is skipped instead of kept", "src/vcu/write-audit.ts",
  '  const recovered = recordFromSalvagedBytes(tail);\n  if (recovered) {',
  '  const recovered = null;\n  if (recovered) {',
  "scripts/check-write-audit.ts"),
 ("#189 the warning is said on every read again", "src/vcu/write-audit.ts",
  '  if (reportedDamage.has(key)) {\n    return;\n  }\n  reportedDamage.add(key);',
  '  reportedDamage.add(key);',
  "scripts/check-write-audit.ts"),
 ("N4 salvaged bytes need no at/action", "src/vcu/write-audit.ts",
  '  if (typeof candidate.at !== "number" || typeof candidate.action !== "string") {\n    return null;\n  }',
  '',
  "scripts/check-write-audit.ts"),
 ("R4 armWrite stops raising busy", "public/views/vcu-write.js",
  '  const name = selectedTarget()?.name;\n  busy.val = true;\n  try {\n    await fetchStatus();',
  '  const name = selectedTarget()?.name;\n  try {\n    await fetchStatus();',
  "scripts/check-write-status-split.ts"),
 ("R6 selectedTarget stops comparing the name", "public/views/vcu-write.js",
  '  return detail && detail.name === selected.val ? detail : null;',
  '  return detail;',
  "scripts/check-write-status-split.ts"),
 ("R10 the cached listing ignores the table type", "public/views/vcu-write.js",
  '    } else if (listingHeldFor !== null && listingHeldFor.tableType !== tableType) {',
  '    } else if (false) {',
  "scripts/check-write-status-split.ts"),
 ("#107 list=0 answers [] instead of null", "src/vcu/write-runner.ts",
  '    targets: request.includeList ? writeTargets().map(listTarget) : null,',
  '    targets: request.includeList ? writeTargets().map(listTarget) : [],',
  "scripts/check-write-status-split.ts"),
 ("R5 the retry window drops below a heartbeat", "public/lib/charge-write.js",
  'export const STATUS_RETRY_MS = 5000;',
  'export const STATUS_RETRY_MS = 1000;',
  "scripts/check-charge-write-polling.ts"),
 ("B1/B3 the guard reads the verdict, not the settle", "public/views/charge-current.js",
  '  const settle = valueOf("charge_cmd_ack_seq");',
  '  const settle = valueOf("charge_cmd_ack");',
  "scripts/check-charge-write-polling.ts"),
 ("cond.2 the registry entry is deleted", "src/can/registry.ts",
  '  { key: "charge_cmd_ack_seq", unit: "", group: "charge", source: "sensor", onDemand: true },',
  '',
  "scripts/check-charge-write-polling.ts"),
 ("cond.1 a deadband swallows the settle edge", "src/can/registry.ts",
  '  { key: "charge_cmd_ack_seq", unit: "", group: "charge", source: "sensor", onDemand: true },',
  '  { key: "charge_cmd_ack_seq", unit: "", group: "charge", source: "sensor", onDemand: true, deadband: 1 },',
  "scripts/check-charge-write-polling.ts"),
 ("#207 the session-start retry is never re-attempted", "public/lib/charge-write.js",
  '  if (!live || writeStatus.rawVal !== null) {\n    return;\n  }',
  '  if (!live || statusAskedAt !== null) {\n    return;\n  }',
  "scripts/check-charge-write-polling.ts"),
 ("#107 the charge views stop raising busy before the pre-arm refresh", "public/views/charge-current.js",
  '  busy.val = true;\n  try {\n    await fetchChargeWriteStatus();',
  '  try {\n    await fetchChargeWriteStatus();',
  "scripts/check-charge-write-visibility.ts"),
]

results = []
for label, path, find, repl, script in M:
    text = open(path, encoding="utf-8").read()
    if find not in text:
        results.append((label, script, "PATCH DID NOT APPLY — not a kill"))
        continue
    open(path, "w", encoding="utf-8").write(text.replace(find, repl, 1))
    run = subprocess.run(["node", "--experimental-strip-types", script], capture_output=True, text=True)
    subprocess.run(["git", "checkout", "--", path], check=True)
    verdict = "KILLED (exit %d)" % run.returncode if run.returncode != 0 else "⚠️ SURVIVED (exit 0)"
    first_red = next((l.strip() for l in (run.stdout + run.stderr).splitlines() if l.strip().startswith("✗")), "")
    results.append((label, script, verdict, first_red))

print()
for r in results:
    print(f"{r[2]:<22} {r[0]}")
    print(f"{'':<22}   {r[1]}")
    if len(r) > 3 and r[3]:
        print(f"{'':<22}   first red: {r[3][:150]}")
survived = [r for r in results if "SURVIVED" in r[2] or "DID NOT APPLY" in r[2]]
print(f"\n{len(results) - len(survived)}/{len(results)} mutations killed")
sys.exit(1 if survived else 0)
