#!/bin/sh
set -eu
# A missing/broken app or stale/missing bike readings defer all unattended package installation.
if ! readiness=$(curl --fail --silent --show-error --max-time 3 http://127.0.0.1/os-update-ready); then
    printf '%s\n' 'Cool Eva power check unavailable; deferring OS updates.' >&2
    exit 1
fi
printf '%s\n' "$readiness" | jq -es 'length == 1 and .[0].ok == true' >/dev/null
