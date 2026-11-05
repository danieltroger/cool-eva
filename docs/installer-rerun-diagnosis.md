# Installer rerun diagnostics

The later [integrated #353 run](https://github.com/danieltroger/cool-eva/actions/runs/42001149738) passed fresh/resume, rerun and reboot, then failed service activation and restoration after the synthetic legacy move. [Installer service control](installer-service-control.md) records the separate command-deadline risk and recovery behavior. This later failure does not classify earlier SSH failures as emulator-only.

The rerun failures in CI runs [41913122763](https://github.com/danieltroger/cool-eva/actions/runs/41913122763) (SSH banner timeout after setup) and [41951170785](https://github.com/danieltroger/cool-eva/actions/runs/41951170785) (dashboard health failure during setup) remain unclassified. A successful local reproduction attempt cannot establish that either failure happens only in an emulator.

## What was measured locally

The exact unverified ARM64 artifact from run 41951170785, merge `1586dc47253f69721e8d29707e004e950c6823e3`, passed fresh installation, SSH interruption during apt, same-line rerun, reboot, and the synthetic legacy migration locally. Its unchanged archive SHA-256 is `773a65fd73ce4e22bbe514176318249aa7138b4b07f6c132f54443adca010fdc`.

Both hosts use pinned QEMU 11.1.3/libslirp 4.9.7, `raspi3ap`, four Cortex-A53 cores, 512 MiB, multi-threaded TCG, and the pinned Trixie image's kernel/DTB. The local host is macOS; CI is Linux, so the execution environments are not identical.

On the first boot, systemd's monotonic main-process start timestamp to the HTTP-listening journal entry was **19.59 seconds** initially and **19.69 seconds** during rerun. At the captured healthy points, available guest memory was 128–136 MiB with 21–23 MiB swap used. The OS catch-up and periodic apt units were inactive by app startup. The full kernel/journal capture recorded no OOM kill, segfault, or fatal signal in that reproduction. These observations describe that run, not the missing failure window in CI.

The installer allows three minutes overall and requires a full healthy minute from one process generation. Individual HTTP probes have a three-second deadline. These limits and SSH's connection deadline were retained.

A second, explicitly overlaid guest experiment ran the same installer rerun while two CPU-only workers each consumed roughly one core, bounded to 100 guest seconds from the old app's stop. The replacement app reached HTTP in **23.83 seconds** and completed the healthy minute. A live snapshot during that load had 147 MiB available and 45 MiB swap used; SSH answered. This exercised a particular load, not every possible resource-pressure failure.

## A separate normal-stop bug

The local trace did reproduce an application error on normal service stops: systemd signals both Node and its flock/cat settings-lock helper. The helper's termination rejected the promise that shutdown awaited, so the app exited with status 1 and invoked `OnFailure`. This also happened during the successful rerun; it does not establish the cause of either CI failure.

Lock acquisition still refuses an early exit or a busy lock. Once release has fenced further writes, an exited holder has already relinquished the lock; cleanup logs its nonzero/signal status and completes. An unexpectedly lost holder still makes `assertHeld()` fail before another settings write. A holder that will not stop still times out. The portable check covers termination during release and unexpected lock loss, and catches mutations of either behavior.

The real-systemd comparison uses the disposable guest only: the original code exits 1 on stop; a process started after overlaying only the corrected `writer-lock.ts` exits 0 with `Result=success`. The downloaded archive remains unchanged. This local overlay is a focused experiment, not a newly verified release artifact.

## Capture that survives the rerun

The original serial observer stopped near the first login prompt, leaving no guest measurements during the failures. The QEMU seed now masks both getty instances for `ttyS0` and runs two separate units:

- A collector appends to root-only `/var/log/cool-eva-qemu-diagnostics.log`, independently of the serial terminal. It follows application, installer, SSH, apt, NetworkManager and kernel journals and samples memory/pressure, swap/OOM counters, CPU statistics, process names, service states/start times and HTTP readiness every few seconds. Individual service/HTTP queries are bounded so a blocked query does not stop memory sampling.
- A forwarder tails that file to the serial artifact without resetting or hanging up the terminal. The collector file also survives reboot. The local reproduction captured the entire rerun past 1,700 seconds of guest uptime.

The gate verifies that the collector and forwarder are active and that the sample count advances before and after rerun. An active but stalled collector fails that assertion. Before rerun and after a failure, bounded SSH inspection saves the full current-boot application/installer journals, `systemctl status`, `free -m`, process names, full `dmesg`, and the recent persistent samples. Serial capture remains useful when SSH itself fails. Process arguments and Wi-Fi passwords are never sampled.

For local failure inspection, `guest-ssh.json` records loopback port and key **paths**. Set `COOL_EVA_QEMU_PAUSE_ON_FAILURE_SECONDS` to an integer up to 900 to keep a failed guest alive temporarily. This does not retry setup or a runtime fault. The VM is disposable, has synthetic data only, and cannot validate CAN/BLE/GPIO/Wi-Fi hardware or establish real-Pi fault behavior.
