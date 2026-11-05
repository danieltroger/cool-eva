# Installer bootstrap and verification

Setup writes the dispatcher, launcher and updater configuration after the service's settings/storage checks. It installs and validates the shell helper generation before atomically publishing fresh updater state, then writes the service units and starts the app. An interruption before state publication can reuse the helper generation on the next setup attempt.

Before any service unit exists, a bootstrap failure leaves the app unstarted and tells the rider to paste the setup line again. An existing installation uses the normal service-restoration path; if restoration cannot be confirmed, the advice explicitly names the stopped service. An unfinished data migration still requires help. App startup remains fail-open when updater recovery is damaged; Update remains fail-closed.

The standalone installer can repair missing or invalid protocol-1 helpers for existing updater state. It checks the current helper before taking the shared updater lock. A repair validates the recorded release and its full inventory, copies its six helper files into a checked generation, then atomically selects it. It does not change updater state, pending recovery, settings or the app's current release. It releases and closes the repair lock before `install-tag`; Node's later validation uses only syntax/self-test under the installer's existing lock.

Reruns compare the journal's directory name with the actual current directory. An Update promotes a `trial.*` directory whose `release.json` carries the release identity; those two strings need not match.

The QEMU gate runs its twelve post-install assertions in one guest-owned oneshot unit. The host submits once and observes read-only status and a named receipt within one 600-second monotonic budget. A broken SSH observation cannot restart the assertions. Success requires a normal zero exit, successful unit result and all twelve ordered start/end records. Every child uses its own `sh -eu`; the HTTP policy assertion has a test-only ten-second limit. Other SSH deadlines and production startup/health limits are unchanged.

The unit lives under `/run/systemd/system` and has no separate start deadline, so failure inspection can see a still-running child. The existing sampler/inspection captures its journal, state and receipt. Fresh and synthetic legacy installs must both show an actual service-start marker with no helper or dispatcher failure in that journal slice. The portable bootstrap fixtures check helper/state readiness at the service start; Linux additionally exercises real `flock` handoff.

This gate does not emulate CAN, BLE, GPIO, Wi-Fi association, firmware boot or SD power cuts. A slower emulated check does not establish emulator-only behavior on a real Pi.
