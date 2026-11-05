# Installer service activation and recovery

The installer separates submitting a systemd job from the application becoming ready. Killing a slow systemctl client loses the result of the manager operation; it does not reliably cancel a submitted start or reload.

Installer systemctl calls no longer inherit the general 30-second subprocess deadline. Synchronous operations such as `daemon-reload`, enabling units and stopping a service wait for the manager's result. The service-owned migration restart retains its explicit 30-minute allowance and matching unit startup budget. Other installer executables retain their existing limits.

Application activation enables the unit, then submits `start --no-block`. The new bundle still has to pass the existing health check: three minutes overall, a continuous healthy minute from one process generation, and three seconds per HTTP probe. These limits and the Node startup guard are unchanged.

Every failed installer systemctl command logs and throws its exit code or signal, whether Node killed it, and elapsed milliseconds from the monotonic clock. The message names the operation and omits arguments, stdout and stderr. The original exception remains its cause for debugging. An absent-unit response still follows the existing absent-unit path.

## Failure recovery

After failed activation or health checks, an existing install restores its saved service unit, reloads the manager, enables the unit and submits its start without a short client deadline. Recovery observes the actual service state, main PID and restart count within the existing three-minute window. After its first active sample, the same PID must stay active with the same `NRestarts` for at least ten seconds. A restart or loss of active state fails recovery. An old checkout may have no release-health endpoint, so this checks process stability rather than claiming bundle health passed.

A failed service, or an inactive service without a queued job, fails immediately. Target systemd v257 prints an empty `Job=` when no job exists; recovery accepts that and `Job=0` as no job. An inactive unit with `Job=<id>` can still be waiting for its submitted start and remains under observation.

The observation budget is checked again after each manager reply. A delayed reply cannot qualify a process as stable after the three-minute window has already expired.

Preparation records the saved unit before stopping it. If selecting the release subsequently fails, the same recovery applies. If preparation fails before recording a backup, it has not stopped the app and keeps the original failure and retry advice. An unfinished service-owned data migration remains stopped for repair; recovery must not restart old code over a partial move.

Without a previous unit, recovery first checks whether the new unit has been installed. An absent unit keeps the original setup failure and retry advice without waiting on it. An installed unit must pass the same process-stability check; recovery does not repeatedly restart a failed new release until one attempt succeeds. Confirmed recovery says **“A service is running again”**, retaining the original setup error and saying setup is incomplete.

If restoration or state confirmation fails, the rider sees **“Treat the app as STOPPED”**, keeps bench power on, and gets explicit SSH commands: `sudo systemctl daemon-reload`, then `sudo systemctl start cool-eva.service` (or the retained `thermometer.service`). If it will not stay running, stop and ask for help with that unit's journal. This never gives only ordinary paste-again advice. Raw systemctl errors outside recovery keep retry advice, including failures before preparation or after verified health. A permanent or interrupted data migration remains quiescent and asks for help; the installer never moves data itself.

A broken manager or OS can prevent both activation and restoration. The installer cannot guarantee a running app then: the STOPPED result is the unresolved condition. This handling does not remove ride data. A process observed running can fail later; its existing restart and bundle rollback policy still governs later failures.

## Evidence and checks

On integrated #353 head `a468cdb`, [run 42001149738](https://github.com/danieltroger/cool-eva/actions/runs/42001149738) passed fresh setup, SSH interruption/resume, same-line rerun and reboot. The service-owned synthetic legacy move completed, but activation's `enable --now` and restoration's `daemon-reload` both failed, leaving the app stopped. Both inherited the old 30-second deadline. An apt-daily metadata refresh was running at roughly one core, unrelated unit queries also timed out, and no OOM or Node fatal fault was observed. The sanitized errors omitted exit/signal details, so a deadline remained an inference rather than proof of an emulator-only fault. The fix removes that unsafe deadline and makes recovery results explicit regardless of attribution.

The portable `check-installer-service.ts` uses actual command, activation and restoration code with an isolated systemctl adapter. It waits through a real 31-second reload and a separate 31-second enable, then verifies the queued start. Failure cases cover ordinary exit, signal death, an explicitly killed probe, successful old-unit restoration, failed restoration, failed queued start and a stopped fresh install. Logs must contain lifecycle fields without synthetic credential arguments. Corrupt configuration excerpts remain redacted through both recovery outcomes. The check never invokes the host's systemctl.

Recovery edge cases use the same helper source with a private virtual observation clock: empty/zero job fast failure, a queued job, ten full seconds of stability, fresh/pre-unit failures, an untouched thermometer service, active-to-activating crash loops, changed PID and changed restart count. The full portable check also runs the default real clock through the ten-second window after its long manager delays. Installer-source changes trigger the separate real-systemd CI suite.

Mutations restore the 30-second deadline, remove nonblocking start, bypass running-state verification, replace STOPPED advice with the generic retry, omit failure logging/killed state, or reveal a corrupt-file excerpt. Each must fail its relevant check. Native systemd evidence and its precise apt overlap are recorded separately in the lane receipt; a container is not a real-Pi performance measurement. No bike migration or publication is authorized by these checks.
