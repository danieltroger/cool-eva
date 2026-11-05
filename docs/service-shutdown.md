# Requested service shutdown

A requested SIGTERM or SIGINT exits successfully even if cleanup fails. A bundle service's `OnFailure` handler cannot distinguish an already completed manual stop from a crash after the stop job disappears. A nonzero requested exit could therefore undo the stop, or roll back and reject the current release if an earlier automatic restart left `NRestarts > 0`.

`installRequestedShutdown` records intent before running cleanup. Each step logs its name and error and allows the remaining steps to run; normal completion exits 0. An exit listener also converts a nonzero exit to 0 once a stop was requested. This covers an explicit `process.exit(1)` or an unrelated callback throwing while shutdown awaits I/O. Node's fatal diagnostic is retained. Fatal termination can interrupt the remaining cleanup; the exit guard preserves the operator's stop intent, not a guarantee that every resource was flushed.

V8/native aborts, SIGSEGV or a kernel OOM-kill during a requested stop can bypass JavaScript's exit guard and still reach failure handling, potentially restarting or rolling back the selected bundle.

Before a stop request, exit codes and fatal exceptions are unchanged. Real crash loops must still invoke automatic restarts and the existing late rollback. The handler does not depend on `Result=start-limit-hit`: a terminal crash loop can retain `Result=exit-code`. A hung cleanup can still reach systemd's stop timeout/SIGKILL; its existing timeout guard leaves the selected release alone. No `SuccessExitStatus=1` broadens successful exits, and no manual stop is classified from a missing job.

## Why cleanup has this order

The entry point lists the cleanup steps in order. This moves the earlier inline shutdown rationale here without changing the ordering:

- Close the OS-update gate and consume the shared restart reservation before stopping producers. The reservation remains held through process termination.
- Stop OBD polling, CAN/Wi-Fi monitoring, then begin BLE client/server shutdown. BLE disconnection stays in the background so a slow D-Bus operation cannot consume the budget for irreversible data and fan safety. Its rejection is logged instead of becoming an unhandled rejection.
- Abort VCU writes, then await the read runner. An in-flight sweep stops its client from transmitting, settles the request and keeps every appended row in `sweep.partial.jsonl` for the next run. Its archive needs to finish before process exit. A write is aborted without an extra wait: it takes only a few hundred milliseconds of exchanges, owns no file handle or partial state, and its action appends the audit record. Deploy/restart makes this a routine path.
- Stop sealing on park before closing the encrypted log, so a late park event cannot start another seal against a closing log. Await the seal to avoid losing the final buffer.
- Seal the log before fan I/O. The unit has no custom `TimeoutStopSec`, so a wedged sysfs write or `pinctrl` would otherwise spend systemd's 90-second stop budget ahead of unrecoverable ride-log data.
- Stop gestures, fan cycling/automatic control and charging control before idling the bridge. A hold or curve tick after idle could command PWM again and leave enables high. Await fan shutdown before exiting; an earlier cleanup error must not skip this attempt.
- Stop the CAN channel, WebSockets and HTTP, then finish settings writes before releasing the writer lock. Per-step errors remain visible, including a holder-release timeout.

SIGKILL cannot run cleanup. On an actual crash, the five-second restart policy and `openFanPwm()` dropping the enables on startup remain the recovery path. The boot `gpio=` lines are the backstop if the service never comes back. A requested stop deliberately remains stopped; do not rely on an automatic restart to repair a failed fan-idle operation.

## Regression checks

The portable check runs actual Node child processes: clean and failed cleanup, background rejection/hang, repeated signals, explicit exit 1, a fatal callback and an unhandled rejection during stop must all exit 0. A crash or unhandled rejection before any stop request must still exit 1. It also checks that the application installs this shutdown path.

The real-systemd gate uses the production shutdown module in its synthetic app. After one automatic restart (`NRestarts=1`) with a live previous release, the app attempts exit 1 on SIGTERM. A manual stop must stay inactive beyond `RestartSec`, with successful exit, unchanged current/previous releases and no rejected release. The existing timeout and first-CAN-frame crash-loop cases still run afterwards, including rollback and a subsequent successful update.
