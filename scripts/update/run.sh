#!/bin/sh
set -eu
umask 077

main() {
    ACTION=${1:-}
    [ "$#" -eq 0 ] || shift
    if [ "$ACTION" = self-test ]; then
        # Read-only and independent of the app's Node, state and configuration.
        command -v jq >/dev/null
        printf '{"format":1}' | jq -e '.format == 1' >/dev/null
        printf '%s\n' format=1 release=test commit=test channel=main platform=linux-arm64 node=24 archive=bundle.tar.zst sha256=test bytes=1 | validate_manifest_file /dev/stdin
        if printf 'format=1\nrelease=$(id)\n' | validate_manifest_file /dev/stdin; then return 1; fi
        return 0
    fi
    CONFIGURATION=/etc/cool-eva/update.json
    if [ "${1:-}" = --config ]; then CONFIGURATION=$2; shift 2; fi
    REQUESTED_TAG=
    if [ "$ACTION" = install-tag ]; then
        [ "$#" = 1 ] || fail 'Give one immutable release tag.'
        REQUESTED_TAG=$1
        ACTION=update
    else
        [ "$#" = 0 ] || fail 'Unexpected updater arguments.'
    fi
    case "$ACTION" in update|failure|recover|repair|initialise) ;; *) fail 'Unknown updater action.' ;; esac
    load_configuration
    [ ! -L "$PRIVATE/update.lock" ] || fail 'Unsafe update lock.'
    exec 9>>"$PRIVATE/update.lock"
    if [ "$ACTION" = recover ]; then
        # A live update owns recovery until it exits. ExecStartPre must never wait on it.
        flock -xn 9 || return 0
    else
        flock -x -w 2100 9 || fail 'Another update is still running.'
    fi
    case "$ACTION" in
        initialise) initialise ;;
        update) apply_update ;;
        failure) handle_failure ;;
        recover) read_state; repair_pending ;;
        repair)
            read_state
            repair_pending
            if jq -e '.status.running == true' "$STATE" >/dev/null; then
                record_status false false 'Update interrupted — press Update again.'
            fi
            start_current ;;
    esac
}

initialise() {
    [ ! -e "$STATE" ] && [ ! -L "$STATE" ] || fail 'The updater is already initialised.'
    initial_target=$(basename "$(readlink -f "$RELEASE_ROOT/current")")
    valid_release_directory "$initial_target" || fail 'Invalid initial release.'
    verify_storage
    ensure_helpers "$initial_target"
    read_os_packages
    initial_state=$(mktemp "$PRIVATE/state.XXXXXX")
    jq -n --arg current "$initial_target" --arg os "$OS_PACKAGES" \
        '{format:1,current:$current,previous:null,snapshot:null,pending:null,rejected:[],lastRollback:null,osPackages:{($current):$os}}' > "$initial_state"
    chmod 600 "$initial_state"
    sync
    mv -fT "$initial_state" "$STATE"
    sync
    set_current "$initial_target"
}

HELPER_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$HELPER_DIRECTORY/common.sh"
. "$HELPER_DIRECTORY/settings.sh"
. "$HELPER_DIRECTORY/download.sh"
. "$HELPER_DIRECTORY/lifecycle.sh"
. "$HELPER_DIRECTORY/helpers.sh"
WORK=
trap 'clean_download' EXIT
main "$@"
