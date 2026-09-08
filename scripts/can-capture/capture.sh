#!/bin/sh
# Raw CAN capture, one file per boot. Started by can-capture.service.
#
# Why a file per boot: the bike power-cycles the Pi, so a single fixed filename
# would be overwritten by the next boot. The Pi has no RTC either, so if it
# boots without network the date can repeat — the boot_id suffix keeps names
# unique regardless of what the clock says.
#
# ⚠️ Until 2026-09 the "one file per boot" claim was only half true: any restart
# of this unit opened a NEW file, and the cool-eva service bounced can0 on every
# start, which killed candump. `-D` below is what makes the claim hold. Issue
# #160 and docs/can-capture.md.
set -eu

DIRECTORY=/home/pi/ride-captures
mkdir -p "$DIRECTORY"

# can0 is brought up by the cool-eva service; wait rather than race it.
# Still needed alongside -D: this waits for the DEVICE to appear (USB
# enumeration), which no socket option can do.
attempt=0
while [ "$attempt" -lt 120 ]; do
  if ip link show can0 >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done

BOOT_ID=$(cut -c1-8 /proc/sys/kernel/random/boot_id)
OUTPUT="$DIRECTORY/capture-$(date +%Y%m%d-%H%M%S)-$BOOT_ID.log"

echo "capturing to $OUTPUT"
# stdbuf -oL: line-buffered, so a hard power cut costs at most the current line.
# 8 h cap so a forgotten capture can't fill the card (~5 MB/min => ~2.6 GB).
#
# -D: don't exit when can0 goes down. The socket stays bound with its filters
# registered (net/can/raw.c raw_notify: NETDEV_DOWN sets ENETDOWN and nothing
# else), so frames resume by themselves and this keeps writing the SAME file.
# Only NETDEV_UNREGISTER — the adapter unplugged — unbinds, and that still exits.
#
# ⚠️ 2>&1 is deliberate and must stay. -D removes the file boundary that used to
# mark a gap, so candump's own "can0: interface down" line is the only evidence
# IN THE FILE that one happened; the journal does not travel with the archive.
exec stdbuf -oL timeout 28800 candump -D -tA can0 > "$OUTPUT" 2>&1
