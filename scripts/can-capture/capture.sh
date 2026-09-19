#!/bin/sh
# Raw CAN capture, one file per boot, compressed as it is written.
# Started by can-capture.service.
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
#
# Why the stream goes through `split | gzip` rather than straight into a file,
# what a power cut now costs, and where 65536 comes from: docs/can-capture.md
# §"Why the capture is compressed, and what a power cut now costs".
set -eu

DIRECTORY=/home/pi/ride-captures
mkdir -p "$DIRECTORY"

# All three binaries are checked HERE, before anything creates a file: `: > "$OUTPUT"`
# below truncates the file whether or not the pipeline can run, so a missing binary
# would otherwise leave one empty capture per restart — ~17 000 a day at RestartSec=5,
# into the directory the archive is swept from. Exiting first leaves no file, and one
# journal line per restart attempt is a visible loop rather than a silent one.
# candump comes from can-utils, which is NOT installed by default on Raspberry Pi OS.
if ! command -v candump >/dev/null 2>&1; then
  echo "candump not found — install it with: sudo apt install can-utils" >&2
  exit 1
fi
for tool in gzip split mktemp cat rm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required to write a compressed capture and record candump's exit status" >&2
    exit 1
  fi
done

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

# The disk floor. Waits rather than exits: `exit 1` would restart-loop at 0.2 Hz
# forever, `exit 0` would leave the unit dead with nothing to restart it when space
# appears. Waiting keeps the unit active and starts capturing within a minute of
# scripts/free-pi-captures.ts freeing space. It never touches the ride log or the
# journal — it only declines to open a capture.
# ⚠️ An unreadable `df` fails CLOSED. Not knowing the free space is not permission
# to fill the card; the .celog ride log is the thing that must not lose.
FLOOR_KB=10485760
waited=0
while :; do
  available=$(df -Pk "$DIRECTORY" | awk 'NR == 2 { print $4 }')
  case "$available" in
    '' | *[!0-9]*)
      echo "disk floor: could not read free space for $DIRECTORY out of df -Pk — refusing to start a capture" >&2
      available=0
      ;;
  esac
  if [ "$available" -ge "$FLOOR_KB" ]; then
    break
  fi
  if [ $((waited % 300)) -eq 0 ]; then
    echo "disk floor: ${available} kB free under $DIRECTORY, floor ${FLOOR_KB} kB — NOT capturing, rechecking every 60 s" >&2
  fi
  waited=$((waited + 60))
  sleep 60
done

BOOT_ID=$(cut -c1-8 /proc/sys/kernel/random/boot_id)
# Whole seconds of uptime. The Pi has no RTC, so this is the ONLY monotonic thing it has:
# `date` below can be years out at this point and has been (#188 — two .celog files and a
# capture named for 2060). Padded to 8 digits so it sorts as a number rather than a string,
# and 8 rather than 6 so the padding has no expiry date the bike can outlive.
UPTIME=$(printf %08d "$(cut -d. -f1 /proc/uptime)")
# ⚠️ Computed AFTER the floor wait, not before: a wait of hours would otherwise put a lie
# in both halves of the name.
# Date FIRST, uptime appended. The uptime fixes what the date cannot — a clock that steps
# mid-boot — while leading with the boot id instead would cost a chronological `ls` over the
# whole archive to fix a hazard that has not fired in the six boots that could show it.
# ⚠️ The MTIME is still whatever the clock says. docs/ride-log-clock.md §5.
OUTPUT="$DIRECTORY/capture-$(date +%Y%m%d-%H%M%S)-$BOOT_ID-$UPTIME.log.gz"
export OUTPUT
# ⚠️ Before `: > "$OUTPUT"`, for the same reason the tool guard is: anything that can fail
# must fail while there is still no file, or each failure leaves an empty capture behind.
# /tmp is tmpfs and that is fine here — two bytes of runtime state read by this same shell,
# never capture data, and a cut that loses it has killed the reader too.
STATUS_FILE=$(mktemp)
: > "$OUTPUT"

echo "capturing to $OUTPUT"
# Why each piece is here — the arguments, the measurements and what a power cut costs are
# in docs/can-capture.md §"The capture unit itself" and §"Why the capture is compressed,
# and what a power cut now costs". In one line each:
#
#   -D            keep the socket when can0 goes down, so one boot is one file (#160)
#   -tA           the absolute timestamps every reader in this repo parses
#   timeout 28800 with -D, the only thing that ever closes a capture
#   stdbuf -oL    candump hands over whole lines, not 4 kB blocks
#   2>&1          candump's "interface down" is the ONLY in-band record of a gap
#   echo # boot   the boot id inside the file; the journal does not travel with the archive
#   split -C      64 kB gzip members: a plain `| gzip` holds 7 s of bus, this holds ~0.6 s
#   -c and >>     without -c gzip writes nowhere; `>` makes every member truncate the file
#   STATUS_FILE   a pipeline reports SPLIT's status, so candump's has to travel out by hand
{
  echo "# boot $BOOT_ID uptime $UPTIME"
  if stdbuf -oL timeout 28800 candump -D -tA can0; then
    echo 0 > "$STATUS_FILE"
  else
    echo $? > "$STATUS_FILE"
  fi
} 2>&1 | split -C 65536 --filter='gzip -1 -c >> "$OUTPUT"'

CANDUMP_STATUS=$(cat "$STATUS_FILE")
rm -f "$STATUS_FILE"
case "$CANDUMP_STATUS" in
  '' | *[!0-9]*)
    echo "candump left no usable exit status ($CANDUMP_STATUS) — failing loudly rather than reporting success" >&2
    exit 1
    ;;
esac
exit "$CANDUMP_STATUS"
