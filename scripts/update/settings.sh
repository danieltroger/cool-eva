#!/bin/sh

verify_storage() {
    [ -f "$SETTINGS" ] && [ ! -L "$SETTINGS" ] && [ "$(stat -c '%u:%a' "$SETTINGS")" = 0:600 ] || fail 'Settings are not ready; finish the service migration first.'
    installation_marker="$DATA_ROOT/state/installed.json"
    [ ! -L "$installation_marker" ] && [ "$(stat -c '%u:%a' "$installation_marker")" = 0:600 ] || fail 'The service installation marker is missing or unsafe.'
    jq -e '.installed == true and (.archiveGroupId | type == "number" and . >= 0 and floor == .)' "$installation_marker" >/dev/null || fail 'The service installation marker is incomplete.'
    jq -e '.migration.complete == true' "$SETTINGS" >/dev/null || fail 'The service migration is incomplete.'
    if jq -e '.migration.source == "legacy"' "$SETTINGS" >/dev/null || [ -e "$DATA_ROOT/state/data-move.json" ]; then
        [ ! -L "$DATA_ROOT/state/data-move.json" ] || fail 'Unsafe service data-move journal.'
        jq -e '.complete == true' "$DATA_ROOT/state/data-move.json" >/dev/null || fail 'The service data move is incomplete.'
    fi
    for archive_path in "$(jq -er .values.rideLogDirectory "$SETTINGS")" \
        "$(jq -er .values.vcuParameterDirectory "$SETTINGS")" "$DATA_ROOT/wifi-diag" "$DATA_ROOT/captures"; do
        canonical_path=$(realpath -m "$archive_path")
        case "$canonical_path/" in "$RELEASE_ROOT/"*) fail 'A data directory is still inside the code; ask the service to finish migration.' ;; esac
        case "$canonical_path/" in "$PRIVATE/"*) fail 'Data directories must not use the reserved updater directory.' ;; esac
    done
}

snapshot_settings() {
    settings_lock
    verify_storage
    SNAPSHOT=$(mktemp "$PRIVATE/settings.XXXXXX")
    cp "$SETTINGS" "$SNAPSHOT"
    chmod 600 "$SNAPSHOT"
    sync
    settings_unlock
}

restore_settings() {
    restore_target=$1
    restore_snapshot=$2
    restore_policy=$3
    settings_lock
    if [ "$restore_policy" = trial ] || ! settings_readable_by "$restore_target"; then
        case "$restore_snapshot" in "$PRIVATE/"settings.*) ;; *) fail 'Unsafe settings snapshot path.' ;; esac
        [ "$(dirname "$restore_snapshot")" = "$PRIVATE" ] || fail 'The snapshot must be a direct updater file.'
        [ -f "$restore_snapshot" ] && [ ! -L "$restore_snapshot" ] || fail 'The settings snapshot is missing.'
        # The old reader, rather than a schema-number guess, is the compatibility authority.
        replacement=$(mktemp "$DATA_ROOT/state/settings.restore.XXXXXX")
        cp "$restore_snapshot" "$replacement"
        chmod 600 "$replacement"
        sync
        mv -fT "$replacement" "$SETTINGS"
        sync
        SETTINGS_RESTORED=true
    else
        SETTINGS_RESTORED=false
    fi
    settings_unlock
}

settings_readable_by() {
    reader_directory="$RELEASE_ROOT/releases/$1"
    "$reader_directory/runtime/bin/node" --experimental-strip-types \
        "$reader_directory/src/release/preflight.ts" settings "$SETTINGS"
}
