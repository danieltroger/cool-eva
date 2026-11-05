# Release identity and startup work

Bundles read their small `release.json` before startup and initially report `branch@commit+unverified`. After HTTP is listening, one background inventory check runs with CPU nice level 19 and idle I/O priority. Exit 0 removes the suffix, an inventory mismatch gives `+edited`, and a timeout, unavailable tool or priority-setup failure keeps `+unverified`. A failed check is logged. The result describes the inventory when that check ran; later edits require another service start, as before. The Update path still checks the archive checksum and inventory before activation.

`/settings` reads the latest completed result without awaiting diagnostics. OS/rollback notices refresh separately, using the existing 60-second notice cache and the service's configured updater directory. Package comparison also runs at low priority. Pending diagnostics cannot hold an HTTP response. A promoted install can therefore show its OS drift notice after the first response rather than blocking that response on `dpkg-query`.

The inventory timeout remains 30 seconds, package-query timeout 10 seconds, and installer health limits remain three minutes overall, a continuous healthy minute from one process, and three seconds per HTTP probe. The pinned Node eager-Wasm guard is unchanged; see [its separate measurements and acceptance requirement](node-wasm-startup.md).

## Failed CI capture

[Run 41978950398](https://github.com/danieltroger/cool-eva/actions/runs/41978950398) used synthetic merge `edf98f148e811e98f296fa537452fd7e3e838b8f`. Its bundle archive SHA-256 is `9a1f7b5acfaa915b98a3d997a2cbdda130ad308dc0adcf826c0925f9097b2044`. The failure occurred while resuming the interrupted fresh installation, before the later same-line rerun.

| Observed event                           | Guest monotonic seconds | Since main process start |
| ---------------------------------------- | ----------------------- | ------------------------ |
| Main process start                       | 2090.613                | 0                        |
| First log: inventory timeout, SIGTERM    | 2193.305                | 102.692 s                |
| Running version `+unverified`            | 2193.833                | 103.220 s                |
| CAN interface unavailable                | 2198.213                | 107.600 s                |
| HTTP listening                           | 2205.660                | 115.047 s                |
| First observed in-guest healthy response | about 2208.940          | about 118.327 s          |

The inventory subprocess has a 30-second timeout, but that does **not** establish that the entire first 102.692 seconds were hashing. This capture did not instrument module loading or the hash's launch. Node startup, TypeScript/Wasm compilation, settings startup, hash execution and host scheduling occupy that earlier interval. The missing updater state meant no `dpkg-query` comparison ran in this particular failure.

The collector subsequently received HTTP 200 responses. The installer's final individual probes timed out, so the capture does not establish that the server never became healthy, nor that hashing alone caused every failed probe. The earlier SSH-banner and rerun-health failures remain unclassified; a passing local run cannot classify them as emulator-only.

## Controlled local comparison

The same exact CI inventory was reconstructed in a disposable guest from the earlier artifact and its changed files, then verified in full before the baseline start. There were **785 inventoried files, 145,465,482 bytes**. Both starts used pinned QEMU 11.1.3/libslirp 4.9.7, `raspi3ap`, four emulated Cortex-A53 cores, 512 MiB, multi-threaded TCG and the pinned Trixie image. Host: macOS ARM64. Each measurement dropped the guest page cache before starting. The fixture disabled automatic app restarts and rollback, and a measurement-only preload recorded monotonic boundaries without changing the Node guard.

| Boundary from main process start                | Original CI code | Deferred diagnostics overlay |
| ----------------------------------------------- | ---------------- | ---------------------------- |
| Measurement preload begins                      | 10.949 s         | 10.440 s                     |
| Main module's first release metadata read       | 17.765 s         | 17.060 s                     |
| Inventory check starts                          | 18.135 s         | 20.011 s                     |
| Inventory check finishes                        | 33.326 s         | 37.454 s                     |
| HTTP listening                                  | 35.115 s         | 20.001 s                     |
| First observed `/release-health` response       | 35.395 s         | 23.086 s                     |
| First observed `/settings` response             | 35.460 s         | 23.474 s                     |
| Installer's unchanged full healthy-minute check | Passed           | Passed                       |

The original startup awaited **15.192 seconds** of inventory verification before CAN initialization and listening. The deferred check took **17.443 seconds** while HTTP was already serving. Its label correctly changed from `+unverified` to `+edited`, because the comparison overlaid source files without rewriting the inventory. This was an explicitly edited experiment, not a newly verified release artifact. The original and candidate preload-to-main intervals include static module evaluation, type stripping and eager Wasm work; they do not isolate Wasm cost.

Before listening, CAN bring-up is awaited (about 0.6 seconds of commands in the original fixture, where the adapter is absent). BLE connection runs asynchronously: its original adapter command finished about nine seconds after listening, so waiting for an actual BLE connection does not gate HTTP. Other small settings/log/sensor/static-file initialization still precedes listening. The comparison removes the proven hash dependency; it does not explain all CI scheduling or network delays.

A separate cold-cache full-inventory hash in that A53 guest took **21.18 seconds**. On native Linux ARM64 with the same Node/bundle, the GNU checksum took **0.0611 seconds**, with a warm cache after extraction and metadata reads. That native host was a Docker Linux VM on Apple ARM64, not a Pi or an SD-card benchmark; no shared host cache was dropped. These are individual observations, not throughput guarantees. The real Zero 2 W measurement is required at the bike.

The measurement logs, journals and inspection captures are retained under `.preview-shots/easy-setup/installer/version-a53-final/`; the native control is `version-native-bench.txt`, and the failed CI capture is `version-ci-41978950398/diagnostics/release/`. Preparation transport failures are retained separately and did not start a measured application. No application fault was retried or replaced with a passing sample.

## Real-Pi acceptance

Saturday's bench checklist adds the read-only full-inventory timing beside the 100 default-flag imports in step 4b; see [the exact procedure](node-wasm-startup.md#required-real-pi-acceptance-only-after-daniels-go). Record existing app startup beside it when available. The branch-prerelease migration and its bundle startup measurement remain a later visit, after Daniel's GO. No extra service restart or migration is authorized by this timing check.
