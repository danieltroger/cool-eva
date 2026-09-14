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

# candump comes from can-utils, which is NOT installed by default on Raspberry Pi OS.
# Checked HERE, before the redirect below exists: `exec … > "$OUTPUT"` is set up by the
# shell and truncates the file BEFORE exec'ing, so a missing binary would leave one empty
# capture per restart — ~17 000 a day at RestartSec=5, into the directory the archive is
# swept from. Exiting first leaves no file — one journal line per restart attempt, which
# at RestartSec=5 is a visible loop rather than a silent one.
if ! command -v candump >/dev/null 2>&1; then
  echo "candump not found — install it with: sudo apt install can-utils" >&2
  exit 1
fi

BOOT_ID=$(cut -c1-8 /proc/sys/kernel/random/boot_id)
# Whole seconds of uptime. The Pi has no RTC, so this is the ONLY monotonic thing it has:
# `date` below can be years out at this point and has been (#188 — two .celog files and a
# capture named for 2060). Padded to 8 digits so it sorts as a number rather than a string,
# and 8 rather than 6 so the padding has no expiry date the bike can outlive.
UPTIME=$(printf %08d "$(cut -d. -f1 /proc/uptime)")
# Date FIRST, uptime appended. The uptime fixes what the date cannot — a clock that steps
# mid-boot — while leading with the boot id instead would cost a chronological `ls` over the
# whole archive to fix a hazard that has not fired in the six boots that could show it.
# ⚠️ The MTIME is still whatever the clock says. docs/ride-log-clock.md §5.
OUTPUT="$DIRECTORY/capture-$(date +%Y%m%d-%H%M%S)-$BOOT_ID-$UPTIME.log"

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
#
# The `echo` puts the boot id and uptime INSIDE the file, for the reason 2>&1 is here: the
# archive travels to the laptop, the journal stays on a card that gets reflashed.
# replay-capture.ts counts an unparseable line as `framesSkipped`, so it costs a reader nothing.
{
  echo "# boot $BOOT_ID uptime $UPTIME"
  exec stdbuf -oL timeout 28800 candump -D -tA can0
} > "$OUTPUT" 2>&1
