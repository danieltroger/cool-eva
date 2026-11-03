#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL

if [ "$#" -ne 0 ] || [ "$(id -u)" -ne 0 ]; then
  echo 'capture prune requires root and no arguments' >&2
  exit 2
fi

DIRECTORY=/var/lib/cool-eva/captures
if [ -L "$DIRECTORY" ] || [ ! -d "$DIRECTORY" ]; then
  echo 'capture directory must be a real directory' >&2
  exit 2
fi
if [ "$(stat -c %u "$DIRECTORY")" -ne 0 ]; then
  echo 'capture directory must be root-owned' >&2
  exit 2
fi
MODE=$(stat -c %a "$DIRECTORY")
case "$MODE" in
  2750) ;;
  *) echo 'capture directory must be root-owned and read-only to the archive group' >&2; exit 2 ;;
esac

for parent in /var /var/lib /var/lib/cool-eva; do
  if [ -L "$parent" ] || [ ! -d "$parent" ] || [ "$(stat -c %u "$parent")" -ne 0 ]; then
    echo 'capture parent directories must be root-owned real directories' >&2
    exit 2
  fi
  parent_mode=$(stat -c %a "$parent")
  if [ "$((0$parent_mode & 022))" -ne 0 ]; then
    echo 'capture parent directories must not be writable by the archive group' >&2
    exit 2
  fi
done

cd "$DIRECTORY"
BOOT_ID=$(cut -c1-8 /proc/sys/kernel/random/boot_id)
case "$BOOT_ID" in
  ????????) ;;
  *) echo 'cannot determine the current boot' >&2; exit 2 ;;
esac
while IFS= read -r name; do
  if ! printf '%s\n' "$name" | grep -Eq '^capture-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}(-[0-9]{8})?\.log(\.gz)?$'; then
    echo 'refusing a non-capture basename' >&2
    exit 2
  fi
  capture_boot=$(printf '%s\n' "$name" | cut -d- -f4 | cut -d. -f1)
  if [ "$capture_boot" = "$BOOT_ID" ]; then
    echo 'refusing a capture from the current boot' >&2
    exit 2
  fi
  if [ -L "$name" ]; then
    echo 'refusing a capture link' >&2
    exit 2
  fi
  if [ -e "$name" ]; then
    if [ ! -f "$name" ]; then
      echo 'refusing a non-regular capture' >&2
      exit 2
    fi
    unlink -- "$name"
  fi
  printf 'GONE\t%s\n' "$name"
done
