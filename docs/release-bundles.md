# ARM64 release bundles

The **ARM64 release bundle** Actions workflow builds Cool Eva, its own Node binary, production runtime dependencies and three prebuilt Linux ARM64 modules. The Pi does not need npm, Git, Python or a compiler to run the result. This is the first part of #324; the existing Git deployment and Update button keep working until the later atomic cutover. The workflow does not install anything on a Pi.

## Build inputs and checks

`scripts/release/inputs.json` pins Node **24.22.2** and its SHA-256, the Debian Trixie ARM64 container by digest, an apt snapshot, and the official Raspberry Pi OS Lite arm64 image/package-list checksums. Every action on the release path uses a full commit SHA with its version in a comment. Nothing in the builder follows a latest tag. Updating these pins is development work when choosing to ship, not a scheduled task. The committed npm lockfile remains the dependency authority.

The tested-image baseline is **2026-10-06 Lite arm64**. Its full package versions are in `tested-os-packages.txt`, downloaded from the immutable image `.info` URL and checked against the committed checksum. `build-os-packages.txt` separately records the builder's package versions. Recording that baseline is not evidence of a VM or hardware boot: the later installer PR must add the QEMU gate before any rider-facing release is published. No Imager manifest or custom OS is generated.

The build source archive comes from the recorded Git commit, selecting tracked app source, release tooling, package inputs and the licence. It never copies a developer's working directory or `node_modules`. Dirty tracked changes are refused; untracked and ignored keys/logs are outside the archive. Private keys, ride archives, capture folders and escaping symlinks are also rejected in the assembled tree.

The container runs one `npm ci --omit=dev --include=optional --ignore-scripts`, immediately asserts that no installed package is marked `dev: true` in the lockfile, then explicitly builds **socketcan, better-sqlite3 and spi-device** with the locked top-level node-gyp and exact Node headers. Missing native builds fail instead of silently disappearing as optional dependencies. Unknown production lifecycle scripts fail until a build step is added. No Pi-side lockfile regeneration is needed.

The bundle deliberately excludes `usocket` and asserts that it cannot resolve from dbus-next, preserving the bike's documented [Node net fallback](pi-install-prerequisites.md#the-four-packages-and-why-it-is-four-and-not-three).

Final payload selection is independent of build staging: `src/`, `public/`, production `node_modules`, `package.json`, the licence, private Node and release/integrity/OS-version metadata. Named runtime helpers are `scripts/can-capture/capture.sh` and the explicit shell/unit allowlist for [bundle updates](bundle-updater.md); the installer is a later increment. Other scripts, checkers, fixtures, docs, README, `.npmrc` and the root lockfile do not ship. Only directories and regular files enter the payload. The runtime dependency graph keeps shared production dependencies while pruning usocket, node-gyp, prebuild-install, nan, node-addon-api, type packages and their unused transitive dependencies. Native build trees retain only their named `.node` binaries. No compiler object files, Python links or npm executable links remain.

Compilation targets ARMv8-A/Cortex-A53. Every production native addon must exist, have ARM64 ELF headers, resolve only the named system libraries, and load with bundled Node. SQLite's test extension is excluded; SQLite executes an in-memory query. The finished archive is extracted into a fresh directory, then its own Node repeats the native loads and usocket-absence check with no system Node on PATH. Validation code runs from build staging, outside the payload. The extracted file inventory and runtime allowlist must match, with no dev packages. These checks open no CAN, Bluetooth, SPI or GPIO devices.

System ABI dependencies are the kernel, glibc (`libc6`), `libstdc++6`, `libgcc-s1` and `libatomic1` if linked; the permitted library names are explicit in the input file. Other OS services required by the app (BlueZ, NetworkManager, systemd, etc.) are installer responsibilities, not downloaded build tools. Python is used by node-gyp **in the builder only**; do not remove the Python supplied by Lite.

## Run it

On macOS or Linux with Node 24 and a working Docker engine:

```sh
node --experimental-strip-types scripts/release/cache.ts fetch dist/release-inputs
node --experimental-strip-types scripts/release/build.ts dist/release
```

Commit first and choose an empty output directory. Bootstrap the [verified input cache](release-input-cache.md) once; the builder then installs its packages offline. Actions fills and saves the same cache before the VM gate, and a main push changing the input recipe warms the default-branch cache. ARM64 hosts build natively; other hosts need Docker's ARM64 emulation. Builds may still download other pinned dependencies. The container uses the invoking user's UID/GID, so staging and output stay owned by that user. No credentials are forwarded into the container.

In Actions, choose **ARM64 release bundle → Run workflow**, choose a branch, and set `channel` to `main` or a name such as `branch-can-fix`. The workflow runs on `ubuntu-24.04-arm`; it also validates PRs changing the bundle tooling. There is no schedule or build triggered by an ordinary application push. The metadata names the actual checked-out SHA, including formatter commits; it does not depend on a formatter push triggering another workflow.

Outputs are `bundle.tar.zst`, `release.json`, `tested-os-packages.txt` and the shell-readable `manifest.txt`. The archive includes `runtime/bin/node`, the Node licence and `files.sha256`; it does not ship npm. The manifest is written only after extraction/native/inventory checks pass and contains the archive hash/size. Do not source a downloaded manifest as shell code.

This first increment uploads **CI artifacts only**. Their 14-day retention is for build debugging; they are not installation URLs. Public GitHub Release publication will be wired after updater/installer/QEMU gates exist: immutable tagged assets, payloads first, manifest last, publish after every gate; HTTPS plus SHA-256, no signing secret. A main-channel release must come from the main branch; branch channels follow their source branch. PR builds validate synthetic merge commits and must never be published. The publishing workflow will accept only an explicit release dispatch on a branch ref. Published rider releases and their assets must never be pruned.

A future release cut still depends on Docker Hub retaining the pinned image digest, snapshot.debian.org retaining the apt snapshot, nodejs.org retaining Node, registry.npmjs.org retaining locked packages, downloads.raspberrypi.com retaining the image/package list, GitHub retaining the pinned action commits, and the `ubuntu-24.04-arm` runner remaining available. An outage or removed input fails CI before publication; repairing that build is work when choosing to ship. Existing installations keep their local bundle, while fresh rider installs depend on the retained GitHub Release assets and the OS package repositories rather than these build services.

## Evidence and limits

The portable `scripts/check-release-bundle.ts` guards action/input pinning, runtime/source selection, dev/build dependency pruning, usocket exclusion, each private-data/path rule, architecture rejection and integrity files; it is included in `npm test`. The ARM64 CI job supplies native-build/load evidence. Image ABI/boot and installer behavior are gated by the later QEMU increment; neither this job nor QEMU proves physical CAN/BLE/GPIO/Wi-Fi behavior or power-cut safety.

Sources read for this design:

- [Node 24.22.2 checksums](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt) and [supported Linux ARM64 ABI](https://github.com/nodejs/node/blob/v24.22.2/BUILDING.md#platform-list).
- [node-gyp Python/header requirements](https://github.com/nodejs/node-gyp/blob/v13.0.0/README.md).
- [Official Lite image and package list](https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-10-06/).
- [GitHub-hosted ARM64 runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
