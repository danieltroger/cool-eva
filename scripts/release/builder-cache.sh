#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
mode=$1
cache=$(realpath "$2")
recipe=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$mode" in fetch|verify|install) ;; *) echo 'Invalid builder cache mode' >&2; exit 1 ;; esac
test -z "$(find -P "$cache" ! -type f ! -type d -print)" || { echo 'Cache contains links or special files' >&2; exit 1; }
awk '!/^[a-z0-9][a-z0-9+.-]*$/ {exit 1}' "$recipe/builder-packages.txt"
set -- $(cat "$recipe/builder-packages.txt")

sources() {
    printf 'Types: deb\nURIs: %s\nSuites: trixie trixie-updates\nComponents: main\nArchitectures: arm64\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n' "$1" > /etc/apt/sources.list.d/debian.sources
    find /var/lib/apt/lists -mindepth 1 -maxdepth 1 -type f -delete
    case "$1" in file:*) by_hash=false ;; *) by_hash=true ;; esac
    apt-get -o Acquire::Retries=5 -o APT::Update::Error-Mode=any -o Acquire::By-Hash="$by_hash" -o Acquire::Languages=none update
}

if [ "$mode" = fetch ]; then
    sources "http://snapshot.debian.org/archive/debian/$APT_SNAPSHOT/"
    mkdir -p "$cache/archives"
    for suite in trixie trixie-updates; do
        destination="$cache/repository/dists/$suite"
        mkdir -p "$destination/main/binary-arm64"
        cp "/var/lib/apt/lists/snapshot.debian.org_archive_debian_${APT_SNAPSHOT}_dists_${suite}_InRelease" "$destination/InRelease"
        packages=$(find /var/lib/apt/lists -maxdepth 1 -type f -name "*_dists_${suite}_main_binary-arm64_Packages*")
        /usr/lib/apt/apt-helper cat-file "$packages" > "$destination/main/binary-arm64/Packages"
    done
    (cd "$cache" && sha256sum --check --strict "$recipe/builder-repositories.sha256")
    apt-get -o Acquire::ForceHash=SHA256 --print-uris --yes --no-install-recommends install "$@" > /tmp/builder-download-plan
    awk '/^\047/ {gsub(/\047/, "", $1); print $1, $2, $3, $4}' /tmp/builder-download-plan > /tmp/builder-downloads
    while read -r uri filename size digest; do
        printf '%s\n' "$filename" | grep -Eq '^[a-z0-9][a-zA-Z0-9+._~%:-]*\.deb$'
        printf '%s\n' "$digest" | grep -Eq '^SHA256:[a-f0-9]{64}$'
        base="http://snapshot.debian.org/archive/debian/$APT_SNAPSHOT/"
        case "$uri" in "$base"pool/*) ;; *) echo 'Unexpected package origin' >&2; exit 1 ;; esac
        if [ ! -f "$cache/archives/$filename" ]; then
            if ! /usr/lib/apt/apt-helper -o Acquire::Retries=0 download-file "$uri" "$cache/archives/$filename.part" "$digest"; then
                echo "Snapshot fetch failed; requesting the identical authenticated bytes from Debian's official pool: $filename"
                /usr/lib/apt/apt-helper -o Acquire::Retries=0 download-file "http://deb.debian.org/debian/${uri#"$base"}" "$cache/archives/$filename.part" "$digest"
            fi
            mv "$cache/archives/$filename.part" "$cache/archives/$filename"
        fi
        printf '%s  %s\n' "${digest#SHA256:}" "$cache/archives/$filename" | sha256sum --check --strict -
    done < /tmp/builder-downloads
fi

(cd "$cache" && sha256sum --check --strict "$recipe/builder-repositories.sha256")
sources "file:$cache/repository"
echo 'Offline APT signed Release and Packages verification passed'
apt-get -o Acquire::ForceHash=SHA256 --print-uris --yes --no-install-recommends install "$@" > /tmp/builder-plan
awk '/^\047/ {print $2, $3, $4}' /tmp/builder-plan > /tmp/builder-archives
test -s /tmp/builder-archives
while read -r filename size digest; do
    printf '%s\n' "$filename" | grep -Eq '^[a-z0-9][a-zA-Z0-9+._~%:-]*\.deb$'
    printf '%s\n' "$digest" | grep -Eq '^SHA256:[a-f0-9]{64}$'
    test "$(stat -c %s "$cache/archives/$filename")" = "$size"
    printf '%s  %s\n' "${digest#SHA256:}" "$cache/archives/$filename" | sha256sum --check --strict -
done < /tmp/builder-archives
awk '{print $1}' /tmp/builder-archives | sort > /tmp/builder-expected
find "$cache/archives" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort > /tmp/builder-actual
cmp /tmp/builder-expected /tmp/builder-actual || { echo 'Cached package set differs from the authenticated install plan' >&2; exit 1; }
printf 'Offline builder package set verified: %s archives\n' "$(wc -l < /tmp/builder-archives)"
if [ "$mode" = install ]; then
    mkdir -p /var/cache/apt/archives/partial
    while read -r filename size digest; do cp "$cache/archives/$filename" /var/cache/apt/archives/; done < /tmp/builder-archives
    apt-get --no-download --yes --no-install-recommends install "$@"
fi
if [ "$mode" = fetch ] && [ -n "${CACHE_OWNER:-}" ]; then chown -R "$CACHE_OWNER" "$cache"; fi
