#!/bin/sh
set -eu

finish_failure() {
    if [ "$2" = recover ]; then
        printf 'cool-eva update: RECOVERY FAILED; starting the complete current release without update supervision. Repair the updater before the next Update.\n' >&2
        exit 0
    fi
    exit "$1"
}

# Installed once outside releases. Journal protocol 1 is shared by both helper generations.
helper_root=/opt/cool-eva/updater
selected_helper=
for generation in current previous; do
    helper="$helper_root/$generation/run.sh"
    if [ -f "$helper" ] && sh -n "$helper" && sh "$helper" self-test; then
        selected_helper=$helper
        break
    fi
    printf 'cool-eva update: %s helper is unavailable; trying the retained helper.\n' "$generation" >&2
done
if [ -z "$selected_helper" ]; then
    printf 'cool-eva update: no working helper; the current app release is unchanged.\n' >&2
    finish_failure 1 "${1:-}"
fi
if sh "$selected_helper" "$@"; then exit 0; else helper_status=$?; fi
case "${1:-}" in update|install-tag) repair_action=repair ;; *) repair_action=${1:-recover} ;; esac
for generation in previous current; do
    retained="$helper_root/$generation/run.sh"
    if [ -f "$retained" ] && sh -n "$retained" && sh "$retained" self-test; then
        if [ "${2:-}" = --config ]; then
            if sh "$retained" "$repair_action" --config "$3"; then finish_failure "$helper_status" "${1:-}"; fi
        elif sh "$retained" "$repair_action"; then
            finish_failure "$helper_status" "${1:-}"
        fi
    fi
done
printf 'cool-eva update: helper failed; retained helpers could not repair it.\n' >&2
finish_failure "$helper_status" "${1:-}"
