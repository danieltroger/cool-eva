#!/bin/sh

install_helpers() {
    helper_source="$RELEASE_ROOT/releases/$1/scripts/update"
    helper_root="$RELEASE_ROOT/updater"
    mkdir -p "$helper_root/versions"
    helper_staging=$(mktemp -d "$helper_root/versions/helper.XXXXXX")
    for helper in run.sh common.sh settings.sh download.sh lifecycle.sh helpers.sh; do
        cp "$helper_source/$helper" "$helper_staging/$helper"
        chmod 700 "$helper_staging/$helper"
        sh -n "$helper_staging/$helper" || fail 'New updater syntax check failed; the existing helper is retained.'
    done
    sh "$helper_staging/run.sh" self-test || fail 'New updater self-test failed; the existing helper is retained.'
    sync
    case "$HELPER_DIRECTORY" in
        "$helper_root/versions/"*) old_helper="versions/${HELPER_DIRECTORY##*/}" ;;
        *)
            old_helper=
            if [ -L "$helper_root/current" ] && sh "$helper_root/current/run.sh" self-test; then
                old_helper=$(readlink "$helper_root/current")
            fi ;;
    esac
    if [ -n "$old_helper" ]; then
        set_link "$helper_root/previous" "$old_helper"
    fi
    set_link "$helper_root/current" "versions/${helper_staging##*/}"
}

ensure_helpers() {
    for helper in run.sh common.sh settings.sh download.sh lifecycle.sh helpers.sh; do
        if ! cmp -s "$RELEASE_ROOT/releases/$1/scripts/update/$helper" "$RELEASE_ROOT/updater/current/$helper"; then
            install_helpers "$1"
            return 0
        fi
    done
}

read_os_packages() {
    installed_packages=$(dpkg-query -W '-f=${binary:Package}\t${Version}\n') || fail 'Cannot record the installed OS package versions.'
    OS_PACKAGES=$(printf '%s\n' "$installed_packages" | awk -F '\t' '
        {sub(/:arm64$/, "", $1)}
        $1 ~ /^(bluez|network-manager|raspi-firmware|linux-image-rpi-v8|libc6|libstdc\+\+6|systemd)$/ {print $1 "\t" $2}')
}
