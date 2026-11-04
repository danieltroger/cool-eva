#!/bin/sh
set -eu
umask 077

# Release assembly replaces this marker; an installer always names its own immutable bundle.
INSTALL_TAG='@COOL_EVA_RELEASE_TAG@'
INSTALL_IMAGE='@COOL_EVA_TESTED_IMAGE@'

main() {
    [ "$(id -u)" = 0 ] || fail 'Run the published installer with sudo.'
    [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = aarch64 ] || fail 'Use Raspberry Pi OS Lite 64-bit.'
    [ "$(dpkg --print-architecture)" = arm64 ] || fail 'Use the 64-bit Lite image, including a 64-bit userspace.'
    printf '%s\n' "$INSTALL_TAG" | grep -Eq '^cool-eva-(main|branch-[a-z0-9.-]+)-[a-f0-9]{40}$' || fail 'Use install.sh from a published Cool Eva release, not the source template.'
    exec 3<>/dev/tty || fail 'Run this through ssh -t so setup can ask its questions.'
    note 'Keep the Pi on a stable mains USB supply throughout setup. Park the motorcycle.'
    printf 'Type BENCH to confirm stable bench power: ' >&3
    IFS= read -r bench_confirmation <&3
    [ "$bench_confirmation" = BENCH ] || fail 'Setup cancelled before any system change.'
    install -d -m 700 /var/cache/cool-eva-install
    [ "$(realpath /var/cache/cool-eva-install)" = /var/cache/cool-eva-install ] || fail 'Unsafe installer cache.'
    exec 9>>/var/cache/cool-eva-install/install.lock
    flock -xn 9 || fail 'Another setup is already running. Let it finish.'
    find -P /var/cache/cool-eva-install -xdev -mindepth 1 -maxdepth 1 -type d -name 'download.*' -exec find -P '{}' -xdev -depth -delete \;
    note "Installing $INSTALL_TAG. Tested image: $INSTALL_IMAGE."
    if ! grep -qs '^VERSION_CODENAME=trixie$' /etc/os-release; then
        note 'This OS differs from the tested Trixie release; proceeding with native and service checks.'
    fi
    note 'Catching up OS packages. Network upgrades can briefly interrupt SSH; paste the same line again if it closes.'
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    dpkg --configure -a
    apt-get -o DPkg::Lock::Timeout=300 -o Dpkg::Use-Pty=0 -o APT::Color=0 update
    apt-get -o DPkg::Lock::Timeout=300 -o Dpkg::Use-Pty=0 -o APT::Color=0 -y -o Dpkg::Options::=--force-confold full-upgrade
    apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends \
        jq curl ca-certificates tar zstd coreutils util-linux iproute2 iw rfkill \
        network-manager bluez dbus openssh-server avahi-daemon \
        libatomic1 libstdc++6 libgcc-s1 raspi-utils
    apt-mark manual jq
    # Until the running app can prove stable charging, package installation stays deferred.
    install -d -m 755 /etc/systemd/system/apt-daily-upgrade.service.d
    if [ ! -e /etc/systemd/system/apt-daily-upgrade.service.d/50-cool-eva-power.conf ]; then
        printf '[Service]\nExecCondition=/bin/false\n' > /etc/systemd/system/apt-daily-upgrade.service.d/50-cool-eva-power.conf.install-next
        chmod 644 /etc/systemd/system/apt-daily-upgrade.service.d/50-cool-eva-power.conf.install-next
        sync
        mv -f /etc/systemd/system/apt-daily-upgrade.service.d/50-cool-eva-power.conf.install-next /etc/systemd/system/apt-daily-upgrade.service.d/50-cool-eva-power.conf
        sync
        systemctl daemon-reload
    fi
    apt-get -o DPkg::Lock::Timeout=300 -o Dpkg::Use-Pty=0 install -y unattended-upgrades
    note 'OS catch-up complete. Downloading the prebuilt software; no Node, Git, Python or compiler installation is needed.'
    install -d -m 755 /opt/cool-eva /opt/cool-eva/releases
    [ "$(realpath /opt/cool-eva/releases)" = /opt/cool-eva/releases ] || fail 'Unsafe release storage.'
    WORK=$(mktemp -d /var/cache/cool-eva-install/download.XXXXXX)
    trap 'clean_download' EXIT
    BASE="https://github.com/danieltroger/cool-eva/releases/download/$INSTALL_TAG"
    fetch "$BASE/manifest.txt" "$WORK/manifest.txt"
    awk -F = 'NF != 2 || $2 !~ /^[a-zA-Z0-9.-]+$/ || seen[$1]++ {exit 1}
        $1 !~ /^(format|release|commit|channel|platform|node|archive|sha256|bytes)$/ {exit 1}
        END {if (NR != 9) exit 1}' "$WORK/manifest.txt" || fail 'Invalid release manifest.'
    RELEASE=$(value release)
    EXPECTED_SHA=$(value sha256)
    EXPECTED_BYTES=$(value bytes)
    [ "$(value format)" = 1 ] && [ "$(value platform)" = linux-arm64 ] && [ "$(value archive)" = bundle.tar.zst ] &&
        [ "$INSTALL_TAG" = "cool-eva-$RELEASE" ] && [ "$RELEASE" = "$(value channel)-$(value commit)" ] || fail 'The installer and bundle identities differ.'
    printf '%s' "$(value commit)" | grep -Eq '^[a-f0-9]{40}$' || fail 'Invalid release commit.'
    printf '%s' "$EXPECTED_SHA" | grep -Eq '^[a-f0-9]{64}$' || fail 'Invalid release checksum.'
    printf '%s' "$EXPECTED_BYTES" | grep -Eq '^[1-9][0-9]{0,9}$' || fail 'Invalid release size.'
    [ "$EXPECTED_BYTES" -lt 536870912 ] || fail 'Release exceeds the download limit.'
    free_kib=$(df -Pk /opt/cool-eva | awk 'END {print $4}')
    [ "$free_kib" -gt $((EXPECTED_BYTES / 1024 * 6 + 1048576)) ] || fail 'Not enough free card space. Keep your ride data backed up before freeing space.'
    if [ -f /var/lib/cool-eva/updater/state.json ]; then
        TARGET=$(readlink -f /opt/cool-eva/current)
        if [ "$(jq -r .release "$TARGET/release.json")" != "$RELEASE" ]; then
            /usr/local/libexec/cool-eva-update install-tag "$INSTALL_TAG"
            jq -e '.status.ok == true' /var/lib/cool-eva/updater/state.json >/dev/null || fail "$(jq -r .status.message /var/lib/cool-eva/updater/state.json)"
            TARGET=$(readlink -f /opt/cool-eva/current)
        fi
        [ "$(jq -r .release "$TARGET/release.json")" = "$RELEASE" ] || fail 'The requested release was not selected.'
        [ ! -L /var/lib/cool-eva/updater/update.lock ] || fail 'Unsafe updater lock.'
        exec 8>>/var/lib/cool-eva/updater/update.lock
        flock -x -w 2100 8 || fail 'An update or rollback is still running. Let it finish before retrying setup.'
        jq -e --arg release "$RELEASE" '.pending == null and .current == $release' /var/lib/cool-eva/updater/state.json >/dev/null || fail 'The release changed while setup was starting. Paste the line again; no service was stopped.'
        [ "$(readlink -f /opt/cool-eva/current)" = "$TARGET" ] || fail 'The selected release changed. Retry setup.'
        note 'Starting the bundled Node installer with the existing release and settings.'
        "$TARGET/runtime/bin/node" --no-wasm-lazy-compilation --experimental-strip-types "$TARGET/src/install/main.ts" "$TARGET"
        return 0
    fi
    TARGET="/opt/cool-eva/releases/$RELEASE"
    if [ ! -e "$TARGET" ]; then
        fetch "$BASE/bundle.tar.zst" "$WORK/bundle.tar.zst"
        [ "$(wc -c < "$WORK/bundle.tar.zst" | tr -d ' ')" = "$EXPECTED_BYTES" ] || fail 'The bundle download was incomplete.'
        printf '%s  %s\n' "$EXPECTED_SHA" "$WORK/bundle.tar.zst" | sha256sum -c - >/dev/null || fail 'Bundle checksum failed; no app was replaced.'
        tar --zstd -tvf "$WORK/bundle.tar.zst" > "$WORK/types.txt"
        awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {exit 1}' "$WORK/types.txt" || fail 'Bundle contains a link or special file.'
        tar --zstd -tf "$WORK/bundle.tar.zst" > "$WORK/paths.txt"
        awk '/^\// || /(^|\/)\.\.(\/|$)/ || /\\/ || /[[:cntrl:]]/ {exit 1}' "$WORK/paths.txt" || fail 'Unsafe bundle path.'
        STAGING=$(mktemp -d /opt/cool-eva/releases/install.XXXXXX)
        tar --zstd --no-same-owner --no-same-permissions -xf "$WORK/bundle.tar.zst" -C "$STAGING"
        (cd "$STAGING" && sha256sum --check --strict --quiet files.sha256) || fail 'Extracted bundle failed verification.'
        sync
        mv -T "$STAGING" "$TARGET"
        STAGING=
        sync
    fi
    [ -d "$TARGET" ] && [ ! -L "$TARGET" ] || fail 'Unsafe existing release directory.'
    (cd "$TARGET" && sha256sum --check --strict --quiet files.sha256) || fail 'Existing release files changed; keep them safe and use the dashboard Update path.'
    jq -e --arg release "$RELEASE" '.format == 1 and .updaterProtocol == 1 and .release == $release and .platform == "linux-arm64"' "$TARGET/release.json" >/dev/null || fail 'Unsupported release metadata.'
    note 'Checking the bundled Node runtime and native modules.'
    "$TARGET/runtime/bin/node" --no-wasm-lazy-compilation --experimental-strip-types "$TARGET/src/release/preflight.ts" native || fail 'This bundle cannot load its native modules on the installed OS. No service was replaced.'
    note 'Starting the bundled Node installer.'
    "$TARGET/runtime/bin/node" --no-wasm-lazy-compilation --experimental-strip-types "$TARGET/src/install/main.ts" "$TARGET"
}

note() { printf 'Cool Eva setup: %s\n' "$*"; }
fail() { printf 'Cool Eva setup stopped: %s\nPaste the same setup line to retry; no ride data is removed.\n' "$*" >&2; exit 1; }
value() { sed -n "s/^$1=//p" "$WORK/manifest.txt"; }
fetch() {
    curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
        --max-filesize 536870912 --connect-timeout 20 --max-time 900 --retry 2 --output "$2" "$1" || fail 'Download failed. Check Wi-Fi internet access.'
}
clean_download() {
    case "${WORK:-}" in /var/cache/cool-eva-install/download.*) find -P "$WORK" -xdev -depth -delete ;; esac
    case "${STAGING:-}" in /opt/cool-eva/releases/install.*) find -P "$STAGING" -xdev -depth -delete ;; esac
}

WORK=
STAGING=
main "$@"
