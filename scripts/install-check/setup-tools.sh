#!/bin/sh
set -eu

# Development/CI only. No compiler, Python, Meson or QEMU is installed on the Pi.
mkdir -p "$1"
tools=$(realpath "$1")
qemu_version=11.1.3
qemu_sha=5a8289c7940dc77d3873c81a6c29ba3afe1446fc9d36e77fa1658cdbecb84b22
slirp_version=4.9.7
slirp_sha=d2567fa06a6357c7755d61c67293b2c0bf069b3f2173bde6b76cf768529a1938
mkdir -p "$tools"
cd "$tools"

fetch() {
    if [ ! -f "$2" ]; then
        curl --fail --show-error --location --proto '=https' --retry 2 "$1" --output "$2.part"
        mv "$2.part" "$2"
    fi
    actual=$(shasum -a 256 "$2" | cut -d ' ' -f 1)
    [ "$actual" = "$3" ] || { printf 'Checksum mismatch: %s\n' "$2" >&2; exit 1; }
}

fetch "https://download.qemu.org/qemu-$qemu_version.tar.xz" "qemu-$qemu_version.tar.xz" "$qemu_sha"
fetch "https://gitlab.freedesktop.org/slirp/libslirp/-/archive/v$slirp_version/libslirp-v$slirp_version.tar.gz" "libslirp-v$slirp_version.tar.gz" "$slirp_sha"
if [ ! -d "qemu-$qemu_version" ]; then tar -xf "qemu-$qemu_version.tar.xz"; fi
if [ ! -d "libslirp-v$slirp_version" ]; then tar -xf "libslirp-v$slirp_version.tar.gz"; fi
if [ ! -x python/bin/python3 ]; then python3 -m venv python; fi
python/bin/python3 -m pip install --disable-pip-version-check --cache-dir "$tools/pip-cache" meson==1.9.0 ninja==1.13.0
PATH="$tools/python/bin:$PATH"
export PATH
if [ ! -f slirp-build/build.ninja ]; then
    meson setup slirp-build "libslirp-v$slirp_version" --prefix "$tools/slirp" -Ddefault_library=static
fi
meson install -C slirp-build
mkdir -p qemu-build
cd qemu-build
if [ ! -f build.ninja ]; then
    PKG_CONFIG_PATH="$tools/slirp/lib/pkgconfig:$tools/slirp/lib64/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}" \
        "../qemu-$qemu_version/configure" --target-list=aarch64-softmmu --without-default-features \
        --enable-slirp --enable-tcg --disable-rust --disable-docs --disable-werror \
        --python="$tools/python/bin/python3" --prefix="$tools/qemu"
fi
ninja -j4 qemu-system-aarch64
./qemu-system-aarch64 --version
