# ARM64 release bundles

The **ARM64 release bundle** Actions workflow builds Cool Eva, its own Node binary, all production dependencies and prebuilt Linux ARM64 modules. The Pi does not need npm, Git, Python or a compiler to run the result. This is the first part of #324; the existing Git deployment and Update button keep working until the later atomic cutover. This PR does not install anything on a Pi.

## Build inputs and checks

`scripts/release/inputs.json` pins Node **24.22.2** and its SHA-256, the Debian Trixie ARM64 container by digest, an apt snapshot, and the official Raspberry Pi OS Lite arm64 image/package-list checksums. Nothing in the builder follows a latest tag. Updating these pins is development work when choosing to ship, not a scheduled task. The committed npm lockfile remains the dependency authority.

The tested-image baseline is **2026-10-06 Lite arm64**. Its full package versions are in `tested-os-packages.txt`, downloaded from the immutable image `.info` URL and checked against the committed checksum. `build-os-packages.txt` separately records the builder's package versions. Recording that baseline is not evidence of a VM or hardware boot: the later installer PR must add the QEMU gate before any rider-facing release is published. No Imager manifest or custom OS is generated.

The source archive comes from the recorded Git commit, selecting only tracked `src/`, `public/`, `scripts/`, `docs/`, package files, README and licence. It never copies a developer's working directory or `node_modules`. Dirty tracked changes are refused; untracked and ignored keys/logs are outside the archive. Private keys, ride archives, capture folders and escaping symlinks are also rejected in the assembled tree.

The container runs `npm ci --omit=dev --include=optional --ignore-scripts`, then explicitly builds **socketcan, better-sqlite3, spi-device and usocket** with the locked top-level node-gyp and the exact Node headers. This is deliberate: `usocket`'s own node-gyp 7 cannot use Trixie's Python, and an ordinary optional dependency failure would silently disappear. Unknown production lifecycle scripts fail until a build step is added. No Pi-side lockfile regeneration is needed.

Compilation targets ARMv8-A/Cortex-A53. Every production native addon must exist, have ARM64 ELF headers, resolve only the named system libraries, and load with bundled Node. Only the named production binaries are kept; SQLite's test extension and compiler artifacts are excluded. SQLite also executes an in-memory query. The finished archive is extracted into a fresh directory, then its own Node repeats the native loads with no system Node on PATH. The extracted file inventory must match. These checks open no CAN, Bluetooth, SPI or GPIO devices.

System ABI dependencies are the kernel, glibc (`libc6`), `libstdc++6`, `libgcc-s1` and `libatomic1` if linked; the permitted library names are explicit in the input file. Other OS services required by the app (BlueZ, NetworkManager, systemd, etc.) are installer responsibilities, not downloaded build tools. Python is used by node-gyp **in the builder only**; do not remove the Python supplied by Lite.

## Run it

On macOS or Linux with Node 24 and a working Docker engine:

```sh
node --experimental-strip-types scripts/release/build.ts dist/release
```

Commit first and choose an empty output directory. ARM64 hosts build natively; other hosts need Docker's ARM64 emulation. Builds may download pinned dependencies. The container uses the invoking user's UID/GID, so staging and output stay owned by that user. No credentials are forwarded into the container.

In Actions, choose **ARM64 release bundle → Run workflow**, choose a branch, and set `channel` to `main` or a name such as `branch-can-fix`. The workflow runs on `ubuntu-24.04-arm`; it also validates PRs changing the bundle tooling. There is no schedule or build triggered by an ordinary application push. The metadata names the actual checked-out SHA, including formatter commits; it does not depend on a formatter push triggering another workflow.

Outputs are `bundle.tar.zst`, `release.json`, `tested-os-packages.txt` and the shell-readable `manifest.txt`. The archive includes `runtime/bin/node`, the Node licence and `files.sha256`; it does not ship npm. The manifest is written only after extraction/native/inventory checks pass and contains the archive hash/size. Do not source a downloaded manifest as shell code.

This first increment uploads **CI artifacts only**. Their 14-day retention is for build debugging; they are not installation URLs. Public GitHub Release publication will be wired after updater/installer/QEMU gates exist: immutable tagged assets, payloads first, manifest last, publish after every gate; HTTPS plus SHA-256, no signing secret. Published rider releases and their assets must never be pruned.

## Evidence and limits

The portable `scripts/check-release-bundle.ts` guards input pinning, source selection, private-data/path escapes, architecture rejection and integrity files; it is included in `npm test`. The ARM64 CI job supplies the native-build/load evidence. Neither proves physical CAN/BLE/GPIO/Wi-Fi behavior or power-cut safety.

Sources read for this design:

- [Node 24.22.2 checksums](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt) and [supported Linux ARM64 ABI](https://github.com/nodejs/node/blob/v24.22.2/BUILDING.md#platform-list).
- [node-gyp Python/header requirements](https://github.com/nodejs/node-gyp/blob/v13.0.0/README.md).
- [Official Lite image and package list](https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-10-06/).
- [GitHub-hosted ARM64 runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
