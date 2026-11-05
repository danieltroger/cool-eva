# Defensive Wasm startup guard

Bundle entrypoints pass `--no-wasm-lazy-compilation` to the unchanged, pinned Node 24.22.2 binary. This changes when V8 compiles WebAssembly; ordinary JavaScript JIT remains enabled. It is a defensive guard for a failure observed on emulated Cortex-A53, not a claim that a real Pi has reproduced it. The installer and gate do not retry this fault. The gate also rejects automatic app restarts and Node fatal signals, so systemd cannot turn a failed startup sample into a passing test. The same option covers the application launcher, native/settings preflights, installer, service-owned migration and post-boot checks.

## Observed failure and controls

The original artifact used Node SHA-256 `b4855de8c4781130b722ceaec9718fed77cca3eed2e5cfc5455e267c0b9ee3b0`. Local and release CI used QEMU 11.1.3, `raspi3ap`, four Cortex-A53 cores, 512 MiB and `tcg,thread=multi`, with the pinned Trixie image and its kernel 6.18.50+rpt-rpi-v8. Their hosts were macOS ARM64 and Ubuntu ARM64 respectively.

[The first CI run](https://github.com/danieltroger/cool-eva/actions/runs/41820810594) passed fresh installation, then its rerun exited 139 before installer questions. A local import-only control reproduced a fatal signal from the bundled Node `MainThread`. GDB captured another failure on import 26, after 25 normal exits: a Wasm lazy-compilation call returned to code ending at a page boundary, then executed a `PROT_NONE` page (`SIGSEGV`, `si_code=2`, fault address equal to PC). The page contained zero instructions. A background V8 worker was compiling Wasm. This happens before the installer performs a fetch or migration; it is not a jq, apt or shell crash in that local reproduction.

| Control, same original import/artifact | Result |
| --- | --- |
| Default flags, QEMU multi-thread TCG | Reproduced SIGSEGV, including under GDB |
| Default flags, serialized TCG | 80/80 imports passed |
| Eager Wasm, multi-thread TCG | 80/80 imports passed |
| Default flags, native Linux ARM64 Neoverse-N2 | [100/100 passed](https://github.com/danieltroger/cool-eva/actions/runs/41834254521), same Node hash; 4 KiB pages |

The native host has a different CPU and OS libraries from a Zero 2 W. Its success cannot clear the Pi's Cortex-A53. No matching upstream QEMU fix has been established, so production receives the guard too. The final release gate keeps multi-thread TCG and tests the guarded entrypoints; it does not retry an unguarded failure until one succeeds.

## Startup and memory cost on the 512 MiB image

| Measurement                                        | Default                   | Eager Wasm   |
| -------------------------------------------------- | ------------------------- | ------------ |
| Import outcomes                                    | 19/20 passed; one SIGSEGV | 20/20 passed |
| Import median elapsed, successful samples          | 2.23 s                    | 2.68 s       |
| Import maximum process RSS                         | 94.8 MiB                  | 110.1 MiB    |
| Service start outcomes                             | 5/5 passed                | 5/5 passed   |
| Service median start to healthy HTTP               | 19.30 s                   | 21.17 s      |
| Service maximum Node RSS through healthy HTTP      | 110.3 MiB                 | 122.7 MiB    |
| Service maximum cgroup memory through healthy HTTP | 152.5 MiB                 | 169.3 MiB    |

On this image the guard added **1.88 s** to median service startup and **12.4 MiB** to the maximum observed Node RSS; cgroup peak increased by 16.9 MiB. The installer still requires its separate 60-second health window after startup. The failed default import remains a failed sample and was not replaced; its time is excluded from the successful-sample median. Guarded samples had no faults. These results use 20 alternating import pairs and five alternating service pairs, with the same original artifact and CLI flag as the only Node execution change.

The VM has 512 MiB configured, about 414 MiB visible to Linux and its existing zram swap. The measurement uses the original artifact with only the CLI option varied, alternating modes. Import measurements use GNU time's elapsed time and peak process RSS. Service measurements disable systemd retries and the failure handler, time start to the first successful release-health response, and read Node's peak RSS through that point. CAN, BLE and physical accessories are absent. These are emulator measurements, not a real-Pi latency or loaded-ride memory claim. GNU time is installed only in the disposable measurement guest, not as an installer prerequisite.

## Which paths use Wasm

Node's [pinned TypeScript loader](https://github.com/nodejs/node/blob/v24.22.2/lib/internal/modules/typescript.js#L41) calls Amaro's `transformSync`; [Amaro's Rust parser is compiled to Wasm](https://github.com/nodejs/amaro). The documented existing service already starts `src/index.ts` through built-in type stripping, so Daniel's current working Node service already has this Wasm path, without a reported failure in this track. Its exact Node version and logs have not been inspected by this lane; record them at the bike.

Node's [Undici HTTP/1 client](https://github.com/nodejs/node/blob/v24.22.2/deps/undici/src/lib/dispatcher/client-h1.js#L64) also instantiates an llhttp Wasm parser for fetch. The new installer's health helper uses fetch. The current application source outside that new helper has no fetch call, so existing Pi stability is not evidence that it has exercised this new Undici path. The import-only failure already occurs through type stripping without calling fetch.

## Required real-Pi acceptance, only after Daniel's GO

On the actual Zero 2 W, record the previous and bundled Node versions and keep the reviewed backup/bench-power requirements. Run the installed bundle import **100 times with default Node flags**, without retrying a failed attempt or counting a later success as its replacement:

```sh
cd /opt/cool-eva/current
completed=0
for attempt in $(seq 1 100); do
    printf 'Default-flag import %s/100\n' "$attempt"
    if env -u NODE_OPTIONS -u NODE_PATH ./runtime/bin/node --experimental-strip-types --input-type=module --eval "await import('./src/install/main.ts')"; then
        completed=$attempt
    else
        exit_status=$?
        printf 'FAILED import %s: exit %s\n' "$attempt" "$exit_status"
        break
    fi
done
printf 'Completed %s/100 default-flag imports.\n' "$completed"
```

This imports definitions; it does not call the installer, migrate data, stop the service or transmit CAN. Preserve the completed count, exit status and any fatal-signal evidence. If all 100 pass, the guard becomes a deletion candidate for a separate reviewed change. If a default-flag import faults, keep it. Then verify the guarded service's startup, memory, storage, actual CAN/BLE/accessories and Update as part of Daniel's first migration. No lane may run this on the bike without his explicit GO.

Saturday 2026-11-07 step 4b runs the import loop above from the reviewed scratch bundle directory, rather than assuming `/opt/cool-eva/current` already exists. It does not install that bundle. While on bench power, also time its full inventory without modifying anything:

```sh
time sha256sum --check --strict --quiet files.sha256
```

Keep the checksum exit status and real/user/sys timings, bundle archive SHA-256, board model, OS/kernel/Node versions and inventory file count beside the import result. Pair this with the existing service's `systemctl show cool-eva.service --property=ExecMainStartTimestampMonotonic` and HTTP-listening journal timestamp from its already authorized boot/start; record the first healthy HTTP time if it was captured. Do not restart the service solely for this measurement. If bundle startup has not yet been authorized, mark that comparison pending until the later migration visit. The branch-prerelease migration is deliberately not part of Saturday. [The startup investigation](release-startup.md) explains why hash duration and app startup must be recorded separately.
