#!/bin/sh

load_configuration() {
    [ "$(id -u)" = 0 ] || fail 'Run the updater as root.'
    [ ! -L "$CONFIGURATION" ] && [ "$(stat -c '%u:%a' "$CONFIGURATION")" = 0:600 ] || fail 'Unsafe updater configuration.'
    jq -e '.format == 1 and (.releaseRoot | test("^/[a-zA-Z0-9/_.-]+$")) and
        (.dataRoot | test("^/[a-zA-Z0-9/_.-]+$")) and
        (.settingsLock | test("^/[a-zA-Z0-9/_.-]+$")) and
        (.service | test("^[a-zA-Z0-9-]+\\.service$")) and
        (.channel | test("^(main|branch-[a-z0-9.-]+)$")) and
        (.healthUrl | test("^http://127\\.0\\.0\\.1(:[0-9]+)?/release-health$"))' "$CONFIGURATION" >/dev/null || fail 'Invalid updater configuration.'
    RELEASE_ROOT=$(jq -r .releaseRoot "$CONFIGURATION")
    DATA_ROOT=$(jq -r .dataRoot "$CONFIGURATION")
    SETTINGS_LOCK=$(jq -r .settingsLock "$CONFIGURATION")
    SERVICE=$(jq -r .service "$CONFIGURATION")
    CHANNEL=$(jq -r .channel "$CONFIGURATION")
    HEALTH_URL=$(jq -r .healthUrl "$CONFIGURATION")
    PRIVATE="$DATA_ROOT/updater"
    STATE="$PRIVATE/state.json"
    SETTINGS="$DATA_ROOT/state/settings.json"
    [ -d "$RELEASE_ROOT/releases" ] && [ ! -L "$RELEASE_ROOT/releases" ] || fail 'Release storage is missing.'
    [ "$(realpath "$RELEASE_ROOT")" = "$RELEASE_ROOT" ] || fail 'The release root must be a real directory.'
    [ -d "$PRIVATE" ] && [ ! -L "$PRIVATE" ] && [ "$(stat -c '%u:%a' "$PRIVATE")" = 0:700 ] || fail 'Unsafe updater storage.'
    [ "$(realpath "$DATA_ROOT")" = "$DATA_ROOT" ] || fail 'The data root must be a real directory.'
    [ ! -L "$DATA_ROOT/state" ] && [ "$(stat -c '%u:%a' "$DATA_ROOT/state")" = 0:700 ] || fail 'Unsafe settings storage.'
    case "$DATA_ROOT/" in "$RELEASE_ROOT/"*) fail 'Data must live outside releases.' ;; esac
    export RELEASE_ROOT DATA_ROOT PRIVATE STATE SETTINGS SERVICE CHANNEL HEALTH_URL SETTINGS_LOCK
}

fail() {
    printf 'cool-eva update: %s\n' "$*" >&2
    if [ "${STATE_VALID:-false}" = true ] && [ "${ACTION:-}" = update ]; then
        STATE_VALID=false
        record_status false false "$*"
    fi
    exit 64
}
note() { printf 'cool-eva update: %s\n' "$*"; }

valid_release_directory() {
    case "$1" in ''|*[!a-zA-Z0-9.-]*|.*) return 1 ;; esac
    [ -d "$RELEASE_ROOT/releases/$1" ] && [ ! -L "$RELEASE_ROOT/releases/$1" ]
}

read_state() {
    [ ! -L "$STATE" ] && [ "$(stat -c '%u:%a' "$STATE")" = 0:600 ] || fail 'Unsafe updater state.'
    jq -e '.format == 1 and (.current | type == "string") and
        (.previous == null or (.previous | type == "string")) and
        (.rejected | type == "array") and
        (.pending == null or (.pending.target | type == "string"))' "$STATE" >/dev/null || fail 'Invalid updater state.'
    CURRENT=$(jq -r .current "$STATE")
    valid_release_directory "$CURRENT" || fail 'The recorded current release is missing.'
    STATE_VALID=true
}

record_status() {
    save_state --argjson running "$1" --argjson ok "$2" --arg message "$3" \
        '.status = {running:$running,ok:$ok,message:$message}'
}

save_state() {
    # Every journal replacement reaches storage before its corresponding link switch.
    temporary_state=$(mktemp "$PRIVATE/state.XXXXXX")
    jq "$@" "$STATE" > "$temporary_state" || fail 'Cannot write updater state.'
    chmod 600 "$temporary_state"
    sync
    mv -fT "$temporary_state" "$STATE"
    sync
}

set_link() {
    link_name=$1
    link_target=$2
    temporary_link="$link_name.next"
    [ ! -e "$temporary_link" ] && [ ! -L "$temporary_link" ] || unlink "$temporary_link"
    ln -s "$link_target" "$temporary_link"
    mv -fT "$temporary_link" "$link_name"
    sync
}

set_current() {
    valid_release_directory "$1" || fail 'Rollback target is missing; no link changed.'
    if [ -L "$RELEASE_ROOT/current" ] && [ "$(readlink "$RELEASE_ROOT/current")" = "releases/$1" ]; then return 0; fi
    set_link "$RELEASE_ROOT/current" "releases/$1"
}

settings_lock() {
    [ ! -L "$SETTINGS_LOCK" ] || fail 'Unsafe settings lock.'
    exec 8>>"$SETTINGS_LOCK"
    flock -x -w 30 8 || fail 'Settings are still being written; no settings changed.'
}

settings_unlock() { flock -u 8; exec 8>&-; }

start_current() {
    systemctl reset-failed "$SERVICE"
    # A blocking start would deadlock ExecStartPre against this process's lock.
    systemctl start --no-block "$SERVICE"
}

monotonic_seconds() { cut -d . -f 1 /proc/uptime; }
