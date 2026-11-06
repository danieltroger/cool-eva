# Scheduled packages during setup

Setup keeps its existing installer lock through download, install-tag, Node installation, health checks and failure restoration. Before catch-up can enable timers, it adds a separate `40-cool-eva-install.conf` to apt-daily.service and apt-daily-upgrade.service. The existing `50-cool-eva-power.conf` charging condition remains in force for package installation.

The generated shell condition skips work only when flock reports the reserved lock-conflict status 75. A free or missing lock, a deleted cache directory, or another probe error permits scheduled work. The lock file is never replaced by setup. No timer is disabled or masked; process/session exit or reboot releases the lock without a restoration command.

The guard prevents a new periodic job from starting during installation. It cannot stop a job admitted earlier, including during a gap after SSH disconnects from detached catch-up. Setup observes both units' state and queued jobs for at most 300 seconds before release selection or install-tag. Read-only queries have at most five seconds within that budget; query errors count as busy/unknown. Progress names the units and elapsed time.

At expiry setup warns and continues: “A scheduled package job is still running or could not be checked. Continuing setup. If the health check then fails, keep power on and paste the same line again.” The warning also records elapsed time and the last unit states/query exit codes. It never kills apt or dpkg. An older job may still compete for resources; the unchanged app health check decides whether setup succeeds.

A skipped list-refresh trigger waits for its next calendar elapse, potentially about a day with the [published Trixie APT timer](https://sources.debian.org/src/apt/3.0.3/debian/apt-daily.timer/); catch-up has just refreshed the lists. Package upgrades retry through the existing security timer 15 minutes after the upgrade unit goes inactive, subject to the charging condition. Removing the installer cache cannot strand these scheduled updates.

Health diagnostics report fixed request/body phases for `/release-health` and `/settings`, elapsed and total monotonic time, numeric status and safe error name/cause code. They log failures, healthy-interval resets and completion, not each successful poll. Bodies, parser excerpts, error messages/stacks, settings values, generations, credentials and keys are excluded. The same diagnostics apply to the image gate's post-reboot health check.

The limits remain 180 seconds overall, a full healthy minute for the same process generation, and three seconds per HTTP fetch/body. No workflow or Node flag changes are required.

Portable fixtures execute the installer functions and test guard ordering, queued work, query failures and budget expiry. The existing real-systemd suite executes the actual generated drop-ins with util-linux flock, including a path containing a literal systemd specifier, missing-file/directory positive controls, lock release on success/failure/PTY hangup, natural completion before activation and the retained charging refusal. That distinguishes admission control from merely failing to see a worker marker.
