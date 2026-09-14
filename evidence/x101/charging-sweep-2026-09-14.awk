# 0x101 (state, substate) against the bike's own charge-active bits, over the candump archive.
#
# Keyed on 0x625 b4 -- `ac_charging` (bit 2) and `dc_charging` (bit 5, INVERTED) as
# src/can/charge-manager.ts decodes them -- and not on a mains-current threshold: the
# 0.5 A the earlier pass used is below the floor of charging by docs/charge-manager.md's
# own account. The 0x625 gate (b1 == 0x01, b3 == 0xFF) is that decoder's, reproduced.
function hex(h,   i, v, c, d) {
  if (h == "") { return -1 }
  v = 0; h = toupper(h)
  for (i = 1; i <= length(h); i++) {
    c = substr(h, i, 1); d = index("0123456789ABCDEF", c) - 1
    if (d < 0) { return -1 }
    v = v * 16 + d
  }
  return v
}
# Seconds since 2026-01-01, so a capture crossing midnight cannot make an interval negative.
# 2026 is not a leap year; every file in this archive is 2026.
function stamp(dateField, timeField,   d, t, days, cum) {
  split("0 31 59 90 120 151 181 212 243 273 304 334", cum, " ")
  sub(/^\(/, "", dateField); split(dateField, d, "-")
  sub(/\)$/, "", timeField); split(timeField, t, ":")
  days = cum[d[2] + 0] + d[3]
  return days * 86400 + t[1] * 3600 + t[2] * 60 + t[3]
}
function live(at, now) { return (at != "" && now >= at && now - at <= 1) }
FNR == 1 { file = FILENAME; chgAt = ""; ac = 0; dc = 0; cmAt = ""; cmB7 = "" }
$3 != "can0" { next }
$5 != "[8]" || NF != 13 { malformed[$4]++; next }
$4 == "625" {
  # 1 and 255 in DECIMAL: this awk parses `0x01` as 0, so a hex literal here silently made the
  # gate `b1 == 0 && b3 == 0`, which no real 0x625 satisfies. The whole sweep came back
  # unattributed rather than wrong, which is the right way for it to break.
  if (hex($7) == 1 && hex($9) == 255) {
    flags = hex($10)
    ac = (int(flags / 4) % 2)
    dc = (int(flags / 32) % 2) ? 0 : 1
    chgAt = stamp($1, $2)
  }
}
# 0x610 is tracked ONLY so this script can reproduce the section's two cable-in figures.
# It is not the charge witness — b7 says a session exists, not that current flows, which is
# the distinction that made an earlier two-file pass call DC `20/34`.
$4 == "610" { cmAt = stamp($1, $2); cmB7 = $13 }
$4 == "101" {
  now = stamp($1, $2)
  cable[(live(cmAt, now) ? "0x610-live-b7-0x" cmB7 : "no-0x610-within-1s") " " hex($7) "/" hex($6)]++
  witnessed = live(chgAt, now)
  mode = !witnessed ? "no-0x625-within-1s" : (ac ? "ac_charging" : (dc ? "dc_charging" : "plugged-or-idle-neither-bit"))
  key = mode " " hex($7) "/" hex($6)
  n[key]++
  if (!((key SUBSEP file) in seen)) { seen[key, file] = 1; files[key]++ }
  total++; carrying[file] = 1
}
END {
  for (k in n) { printf "%9d  %4d files  %s\n", n[k], files[k], k }
  for (k in cable) { printf "%9d          CABLE  %s\n", cable[k], k }
  fileCount = 0; for (f in carrying) { fileCount++ }
  bad = 0; for (id in malformed) { bad += malformed[id] }
  printf "TOTALS %d frames of 0x101 across %d files; %d malformed lines skipped (%d of id 101)\n", total, fileCount, bad, malformed["101"]
}

# Run over ~/Documents/cool-eva-archive (266 .log, ~16 GB, ~5 min, one core):
#   awk -f charging-sweep-2026-09-14.awk *.log
# Output committed beside this as charging-sweep-2026-09-14-output.txt. The archive itself is
# gitignored and far too large to commit, which is why the script and its output are here:
# every figure in docs/can-0x101.md §"What the frame says while charging" is reproducible from
# these two files — the charging table from the mode rows, and the two cable-in figures
# (`20/34` beside a live 0x610, `60/62` never beside one) from the CABLE rows.
