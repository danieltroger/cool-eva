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
    install_periodic_apt_guard
    find -P /var/cache/cool-eva-install -xdev -mindepth 1 -maxdepth 1 -type d -name 'download.*' -exec find -P '{}' -xdev -depth -delete \;
    note "Installing $INSTALL_TAG. Tested image: $INSTALL_IMAGE."
    if ! grep -qs '^VERSION_CODENAME=trixie$' /etc/os-release; then
        note 'This OS differs from the tested Trixie release; proceeding with native and service checks.'
    fi
    note 'Catching up OS packages outside SSH. DO NOT UNPLUG the Pi while this runs.'
    note 'If the connection closes, keep power on. Pasting the same line again resumes setup and waits for the OS job.'
    catch_up_os
    drain_periodic_apt
    note 'OS catch-up complete. Downloading the prebuilt software; no Node, Git, Python or compiler installation is needed.'
    install -d -m 755 /opt/cool-eva /opt/cool-eva/releases
    [ "$(realpath /opt/cool-eva/releases)" = /opt/cool-eva/releases ] || fail 'Unsafe release storage.'
    WORK=$(mktemp -d /var/cache/cool-eva-install/download.XXXXXX)
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
        repair_existing_helpers
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
        jq -e --arg current "$(basename "$TARGET")" '.pending == null and .current == $current' /var/lib/cool-eva/updater/state.json >/dev/null || fail 'The release changed while setup was starting. Paste the line again; no service was stopped.'
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

install_periodic_apt_guard() {
    guard_command='[ -e "/var/cache/cool-eva-install/install.lock" ] || exit 0; if /usr/bin/flock --exclusive --nonblock --conflict-exit-code 75 "/var/cache/cool-eva-install/install.lock" /bin/true; then exit 0; else probe_status=$?; fi; [ "${probe_status}" -ne 75 ]'
    guard_command=$(printf '%s\n' "$guard_command" | sed 's/%/%%/g; s/\$/$$/g')
    for periodic_unit in apt-daily.service apt-daily-upgrade.service; do
        guard_directory="/etc/systemd/system/$periodic_unit.d"
        install -d -m 755 "$guard_directory"
        printf "[Service]\nExecCondition=/bin/sh -c '%s'\n" "$guard_command" > "$guard_directory/40-cool-eva-install.conf.next"
        chmod 644 "$guard_directory/40-cool-eva-install.conf.next"
        sync
        mv -f "$guard_directory/40-cool-eva-install.conf.next" "$guard_directory/40-cool-eva-install.conf"
    done
    systemctl daemon-reload || fail 'Cannot prepare the scheduled-package guard.'
}

drain_periodic_apt() {
    read drain_started drain_idle < /proc/uptime
    drain_started=${drain_started%%.*}
    drain_reported=0
    drain_daily=unknown
    drain_upgrade=unknown
    drain_summary='apt-daily.service=unknown apt-daily-upgrade.service=unknown'
    drain_previous=$drain_summary
    note "Waiting for scheduled package jobs (0s): $drain_summary"
    while :; do
        read drain_now drain_idle < /proc/uptime
        drain_elapsed=$((${drain_now%%.*} - drain_started))
        [ "$drain_elapsed" -lt 300 ] || break
        drain_busy=0
        for periodic_unit in apt-daily.service apt-daily-upgrade.service; do
            read drain_now drain_idle < /proc/uptime
            drain_remaining=$((300 - (${drain_now%%.*} - drain_started)))
            [ "$drain_remaining" -gt 0 ] || { drain_busy=1; break; }
            query_seconds=5
            [ "$drain_remaining" -ge 5 ] || query_seconds=$drain_remaining
            if periodic_state=$(timeout "$query_seconds" systemctl show "$periodic_unit" --property=LoadState --property=ActiveState --property=Job 2>/dev/null); then
                periodic_load=$(printf '%s\n' "$periodic_state" | sed -n 's/^LoadState=//p')
                periodic_active=$(printf '%s\n' "$periodic_state" | sed -n 's/^ActiveState=//p')
                periodic_job=$(printf '%s\n' "$periodic_state" | sed -n 's/^Job=//p')
                periodic_job=${periodic_job%% *}
                case "$periodic_active:$periodic_job" in
                    inactive:|inactive:0|failed:|failed:0) : ;;
                    *) [ "$periodic_load" = not-found ] || drain_busy=1 ;;
                esac
                periodic_summary="$periodic_active/job=${periodic_job:-none}"
            else
                query_status=$?
                drain_busy=1
                periodic_summary="unknown/query-exit=$query_status"
            fi
            case "$periodic_unit" in
                apt-daily.service) drain_daily=$periodic_summary ;;
                apt-daily-upgrade.service) drain_upgrade=$periodic_summary ;;
            esac
        done
        drain_summary="apt-daily.service=$drain_daily apt-daily-upgrade.service=$drain_upgrade"
        read drain_now drain_idle < /proc/uptime
        drain_elapsed=$((${drain_now%%.*} - drain_started))
        [ "$drain_elapsed" -lt 300 ] || break
        if [ "$drain_summary" != "$drain_previous" ] || [ "$((drain_elapsed - drain_reported))" -ge 15 ]; then
            note "Waiting for scheduled package jobs (${drain_elapsed}s): $drain_summary"
            drain_previous=$drain_summary
            drain_reported=$drain_elapsed
        fi
        [ "$drain_busy" = 1 ] || return 0
        sleep 2
    done
    note "A scheduled package job is still running or could not be checked (${drain_elapsed}s): $drain_summary. Continuing setup. If the health check then fails, keep power on and paste the same line again."
}

repair_existing_helpers() {
    repair_root=/opt/cool-eva/updater
    if [ -f "$repair_root/current/run.sh" ] && sh -n "$repair_root/current/run.sh" && sh "$repair_root/current/run.sh" self-test; then return 0; fi
    [ "$(realpath /var/lib/cool-eva/updater)" = /var/lib/cool-eva/updater ] && [ "$(stat -c '%u:%a' /var/lib/cool-eva/updater)" = 0:700 ] || fail 'Unsafe updater storage; no app was stopped.'
    [ ! -L /var/lib/cool-eva/updater/update.lock ] || fail 'Unsafe updater lock.'
    exec 8>>/var/lib/cool-eva/updater/update.lock
    flock -x -w 2100 8 || fail 'An update or rollback is still running. Let it finish.'
    if [ -f "$repair_root/current/run.sh" ] && sh -n "$repair_root/current/run.sh" && sh "$repair_root/current/run.sh" self-test; then
        flock -u 8
        exec 8>&-
        return 0
    fi
    [ ! -L /var/lib/cool-eva/updater/state.json ] && [ "$(stat -c '%u:%a' /var/lib/cool-eva/updater/state.json)" = 0:600 ] || fail 'Unsafe updater state; no app was stopped.'
    jq -e '.format == 1 and (.current | type == "string" and test("^[a-zA-Z0-9][a-zA-Z0-9.-]*$")) and
        (.previous == null or (.previous | type == "string")) and (.rejected | type == "array") and
        (.pending == null or (.pending.target | type == "string"))' /var/lib/cool-eva/updater/state.json >/dev/null || fail 'Invalid updater state; no app was stopped.'
    repair_current=$(jq -r .current /var/lib/cool-eva/updater/state.json)
    repair_source="/opt/cool-eva/releases/$repair_current"
    [ -d "$repair_source" ] && [ ! -L "$repair_source" ] && [ "$(realpath "$repair_source")" = "$repair_source" ] || fail 'Unsafe recorded release; no app was stopped.'
    jq -e '.format == 1 and .updaterProtocol == 1 and .platform == "linux-arm64"' "$repair_source/release.json" >/dev/null || fail 'Unsupported recorded release; no app was stopped.'
    (cd "$repair_source" && sha256sum --check --strict --quiet files.sha256) || fail 'Recorded release was edited. Keep your edits safe; no app was stopped.'
    [ ! -L "$repair_root" ] && [ ! -L "$repair_root/versions" ] || fail 'Unsafe helper storage.'
    mkdir -p "$repair_root/versions"
    [ "$(realpath "$repair_root/versions")" = "$repair_root/versions" ] || fail 'Unsafe helper storage.'
    repair_staging=$(mktemp -d "$repair_root/versions/helper.XXXXXX")
    # Protocol 1 has six files; the old release need not understand a new action.
    for repair_file in run.sh common.sh settings.sh download.sh lifecycle.sh helpers.sh; do
        cp "$repair_source/scripts/update/$repair_file" "$repair_staging/$repair_file"
        chmod 700 "$repair_staging/$repair_file"
        sh -n "$repair_staging/$repair_file" || fail 'The repaired helper failed its syntax check.'
    done
    sh "$repair_staging/run.sh" self-test || fail 'The repaired helper failed its self-test.'
    sync
    [ ! -e "$repair_root/current.next" ] && [ ! -L "$repair_root/current.next" ] || unlink "$repair_root/current.next"
    ln -s "versions/${repair_staging##*/}" "$repair_root/current.next"
    mv -fT "$repair_root/current.next" "$repair_root/current"
    sync
    flock -u 8
    exec 8>&-
}

catch_up_os() {
    os_unit=cool-eva-install-os.service
    cat > /var/cache/cool-eva-install/os-catch-up.sh.next <<'OS_CATCH_UP'
#!/bin/sh
set -eu
umask 077
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
dpkg --configure -a --force-confold --force-confdef
apt-get -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef -o DPkg::Lock::Timeout=300 -o Dpkg::Use-Pty=0 -o APT::Color=0 update
apt-get -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef -o DPkg::Lock::Timeout=300 -o Dpkg::Use-Pty=0 -o APT::Color=0 -y full-upgrade
apt-get -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef -o DPkg::Lock::Timeout=300 install -y --no-install-recommends \
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
apt-get -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef -o DPkg::Lock::Timeout=300 -o Dpkg::Use-Pty=0 install -y unattended-upgrades
OS_CATCH_UP
    chmod 700 /var/cache/cool-eva-install/os-catch-up.sh.next
    mv -f /var/cache/cool-eva-install/os-catch-up.sh.next /var/cache/cool-eva-install/os-catch-up.sh
    install -d -m 755 /etc/systemd/system
    cat > /etc/systemd/system/cool-eva-install-os.service.next <<'OS_UNIT'
[Unit]
Description=Cool Eva setup OS catch-up (keep power on)
[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=infinity
ExecStart=/bin/sh /var/cache/cool-eva-install/os-catch-up.sh
OS_UNIT
    chmod 644 /etc/systemd/system/cool-eva-install-os.service.next
    mv -f /etc/systemd/system/cool-eva-install-os.service.next /etc/systemd/system/cool-eva-install-os.service
    systemctl daemon-reload || fail 'Cannot prepare the independent OS job.'
    os_state=$(systemctl show "$os_unit" --property=ActiveState --value)
    case "$os_state" in
        activating|active) note 'Resuming the existing OS job; keep power on.' ;;
        *)
            if [ "$os_state" = failed ]; then
                systemctl reset-failed "$os_unit" || fail 'Cannot reset the OS job.'
            fi
            systemctl start --no-block "$os_unit" || fail 'Cannot start the independent OS job.'
            ;;
    esac
    # Only this journal follower belongs to SSH; apt/dpkg belong to PID 1's service.
    journalctl --unit="$os_unit" --follow --lines=10 --no-pager 9>&- &
    PROGRESS_PID=$!
    inactive_since=
    while :; do
        os_state=$(systemctl show "$os_unit" --property=ActiveState --value)
        case "$os_state" in
            active) break ;;
            activating|deactivating) inactive_since=; sleep 2 ;;
            inactive)
                os_now=$(cut -d . -f 1 /proc/uptime)
                inactive_since=${inactive_since:-$os_now}
                if [ "$((os_now - inactive_since))" -gt 60 ]; then
                    os_jobs=$(systemctl list-jobs --no-legend --no-pager) || fail 'Cannot inspect the OS job. Keep power on and paste the setup line again.'
                    if ! printf '%s\n' "$os_jobs" | awk -v unit="$os_unit" '$2 == unit {found=1} END {exit !found}'; then
                        fail 'OS catch-up did not start. Keep power on; paste the same setup line again to resume.'
                    fi
                fi
                sleep 2
                ;;
            *) fail 'OS catch-up failed. Keep power on; paste the same setup line again to resume.' ;;
        esac
    done
    stop_progress
    systemctl stop "$os_unit" || fail 'Cannot finish the OS job.'
}

stop_progress() {
    if [ -n "${PROGRESS_PID:-}" ] && kill -0 "$PROGRESS_PID" 2>/dev/null; then
        kill "$PROGRESS_PID" || note 'The OS journal follower already stopped.'
    fi
    PROGRESS_PID=
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
PROGRESS_PID=
trap 'clean_download; stop_progress' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
main "$@"
