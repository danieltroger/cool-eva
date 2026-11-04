#!/bin/sh

download_release() {
    WORK=$(mktemp -d "$PRIVATE/download.XXXXXX")
    if [ -n "$REQUESTED_TAG" ]; then
        TAG=$REQUESTED_TAG
    else
        fetch_asset "https://github.com/danieltroger/cool-eva/releases/download/cool-eva-channels/$CHANNEL.txt" "$WORK/channel.txt"
        TAG=$(cat "$WORK/channel.txt")
    fi
    case "$TAG" in cool-eva-*) ;; *) fail 'Invalid release tag.' ;; esac
    case "$TAG" in *[!a-zA-Z0-9.-]*|*..*) fail 'Unsafe release tag.' ;; esac
    BASE_URL="https://github.com/danieltroger/cool-eva/releases/download/$TAG"
    fetch_asset "$BASE_URL/manifest.txt" "$WORK/manifest.txt"
    validate_manifest_file "$WORK/manifest.txt" || fail 'Invalid release manifest.'
    RELEASE=$(manifest_value release)
    EXPECTED_SHA=$(manifest_value sha256)
    EXPECTED_BYTES=$(manifest_value bytes)
    [ "$(manifest_value format)" = 1 ] && [ "$(manifest_value platform)" = linux-arm64 ] && \
        [ "$(manifest_value archive)" = bundle.tar.zst ] && [ "$TAG" = "cool-eva-$RELEASE" ] || fail 'Unsupported bundle.'
    manifest_commit=$(manifest_value commit)
    printf '%s' "$manifest_commit" | grep -Eq '^[a-f0-9]{40}$' || fail 'Invalid release commit.'
    [ "$RELEASE" = "$(manifest_value channel)-$manifest_commit" ] || fail 'The manifest release identity does not match.'
    [ "$(manifest_value channel)" = "$CHANNEL" ] || [ -n "$REQUESTED_TAG" ] || fail 'The channel points to another channel.'
    printf '%s' "$EXPECTED_SHA" | grep -Eq '^[a-f0-9]{64}$' || fail 'Invalid bundle checksum.'
    printf '%s' "$EXPECTED_BYTES" | grep -Eq '^[1-9][0-9]{0,9}$' || fail 'Invalid bundle size.'
    [ "$EXPECTED_BYTES" -lt 536870912 ] || fail 'Bundle exceeds the 512 MiB limit.'
    if jq -e --arg release "$RELEASE" '.rejected | index($release) != null' "$STATE" >/dev/null; then
        fail 'This release already failed. The previous release is running; wait for a corrected release.'
    fi
    if [ "$(jq -r .release "$RELEASE_ROOT/releases/$CURRENT/release.json")" = "$RELEASE" ] && release_unedited "$CURRENT"; then
        ensure_helpers "$CURRENT"
        record_status false true 'Already up to date.'
        note 'Already up to date.'
        exit 0
    fi
    # Extraction, the previous bundle and an edit archive coexist on the same filesystem.
    available_kib=$(df -Pk "$RELEASE_ROOT" | awk 'END {print $4}')
    [ "$available_kib" -gt $((EXPECTED_BYTES / 1024 * 6 + 262144)) ] || fail 'Not enough free space; the current release is unchanged.'
    fetch_asset "$BASE_URL/bundle.tar.zst" "$WORK/bundle.tar.zst"
    [ "$(wc -c < "$WORK/bundle.tar.zst" | tr -d ' ')" = "$EXPECTED_BYTES" ] || fail 'The bundle download was incomplete.'
    printf '%s  %s\n' "$EXPECTED_SHA" "$WORK/bundle.tar.zst" | sha256sum -c - >/dev/null || fail 'The bundle checksum did not match.'
    # Our builder emits only regular files and directories: never extract links or devices as root.
    tar --zstd -tvf "$WORK/bundle.tar.zst" > "$WORK/types.txt"
    awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {exit 1}' "$WORK/types.txt" || fail 'The bundle contains a link or special file.'
    tar --zstd -tf "$WORK/bundle.tar.zst" > "$WORK/paths.txt"
    awk '/^\// || /(^|\/)\.\.(\/|$)/ || /\\/ || /[[:cntrl:]]/ {exit 1}' "$WORK/paths.txt" || fail 'The bundle contains an unsafe path.'
    STAGING=$(mktemp -d "$RELEASE_ROOT/releases/trial.XXXXXX")
    tar --zstd --no-same-owner --no-same-permissions -xf "$WORK/bundle.tar.zst" -C "$STAGING"
    TARGET=${STAGING##*/}
    (cd "$STAGING" && sha256sum --check --strict --quiet files.sha256) || fail 'The extracted bundle failed verification.'
    jq -e --arg release "$RELEASE" --arg commit "$manifest_commit" --arg channel "$(manifest_value channel)" --arg node "$(manifest_value node)" \
        '.format == 1 and .updaterProtocol == 1 and .release == $release and .commit == $commit and .channel == $channel and .node == $node and
        .platform == "linux-arm64" and (.settingsSchemaVersion | type == "number")' "$STAGING/release.json" >/dev/null || fail 'Incompatible release metadata.'
    "$STAGING/runtime/bin/node" --experimental-strip-types "$STAGING/src/release/preflight.ts" native
    sync
}

validate_manifest_file() {
    awk -F = 'NF != 2 || $2 !~ /^[a-zA-Z0-9.-]+$/ || seen[$1]++ {exit 1}
        $1 !~ /^(format|release|commit|channel|platform|node|archive|sha256|bytes)$/ {exit 1}
        END {if (NR != 9) exit 1}' "$1"
}

manifest_value() { sed -n "s/^$1=//p" "$WORK/manifest.txt"; }

fetch_asset() {
    curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
        --max-filesize 536870912 --connect-timeout 20 --max-time 600 --retry 2 --output "$2" "$1" || fail 'Cannot download the release; check Wi-Fi and press Update again.'
}

release_unedited() {
    (cd "$RELEASE_ROOT/releases/$1" && sha256sum --check --strict --quiet files.sha256 >/dev/null 2>&1)
}

archive_edits() {
    archive_target=${1:-$CURRENT}
    if ! release_unedited "$archive_target"; then
        edit_archive=$(mktemp "$PRIVATE/edits.XXXXXX.tar")
        tar -cf "$edit_archive" -C "$RELEASE_ROOT/releases/$archive_target" .
        chmod 600 "$edit_archive"
        sync
        note 'Saved local release edits in the private updater directory.'
    fi
}

prune_releases() {
    retained_previous=$(jq -r '.previous // empty' "$STATE")
    for candidate_path in "$RELEASE_ROOT/releases/"*; do
        [ -d "$candidate_path" ] && [ ! -L "$candidate_path" ] || continue
        candidate_name=${candidate_path##*/}
        [ "$candidate_name" != "$CURRENT" ] && [ "$candidate_name" != "$retained_previous" ] || continue
        valid_release_directory "$candidate_name" || fail 'Unsafe release cleanup target.'
        if [ -f "$candidate_path/release.json" ]; then archive_edits "$candidate_name"; fi
        # -P and -xdev prevent following a link or a mounted directory into rider data.
        find -P "$candidate_path" -xdev -depth -delete
    done
}

clean_download() {
    case "${WORK:-}" in "${PRIVATE:-/nonexistent}/"download.*)
        find -P "$WORK" -xdev -depth -delete || note 'A temporary download could not be removed.' ;;
    esac
}

prune_downloads() {
    for stale_download in "$PRIVATE/"download.*; do
        [ -d "$stale_download" ] && [ ! -L "$stale_download" ] || continue
        find -P "$stale_download" -xdev -depth -delete
    done
}
