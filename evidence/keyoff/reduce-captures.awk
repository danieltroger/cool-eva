# As scan.awk, plus the two things the first pass lacked: a frame INDEX on every
# event, and every timestamp discontinuity. The wall clock in these files steps
# (docs/can-0x101.md §"The trap in the second corpus"), so an interval measured
# across one is not a duration — the index is the clock-independent witness.
BEGIN { prev101 = ""; prev102 = ""; frames = 0; nonframe = 0; malformed = 0; prevday = ""; prevsec = -1 }
{
  if ($3 != "can0") { nonframe += 1; next }
  if (NF < 6) { malformed += 1; next }
  d = substr($1, 2)
  t = substr($2, 1, length($2) - 1)
  split(t, hms, ":")
  sec = hms[1] * 3600 + hms[2] * 60 + hms[3]
  frames += 1
  if (first == "") { first = d " " t }
  if (prevday != "" && (d != prevday || sec - prevsec > 1 || sec < prevsec)) {
    print "GAP " prevday " " prevtime " " d " " t " " frames
  }
  prevday = d; prevtime = t; prevsec = sec
  last = d " " t
  id = $4
  if (id == "101") {
    cur = $6 " " $7
    if (cur != prev101) { print "S101 " d " " t " " cur " " frames; prev101 = cur }
  } else if (id == "102") {
    if ($7 != prev102) { print "B102 " d " " t " " $7 " " frames; prev102 = $7 }
  } else if (id == "501") {
    psu = d " " t " " $6 " " $7 " " frames
  }
}
END {
  print "FIRST " first
  print "LAST " last
  print "FRAMES " frames
  print "NONFRAME " nonframe
  print "MALFORMED " malformed
  if (psu != "") { print "PSU " psu }
}
