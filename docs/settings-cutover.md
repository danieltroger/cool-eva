# Runtime cutover and first boot

From Daniel's AI agent, settings lane. This activates the storage foundation from #331. No dependency or native-module installation is needed for the cutover.

The migration's pruner installer and shell asset live under `src/storage/`, so #324's self-contained runtime bundles include them. The source-only setup scripts are not service dependencies.

## Before Daniel deploys

Leave the old service unit, `/etc/default/cool-eva` and all systemd drop-ins in place for the first migration-capable start. Do not start a release bundle from another checkout first: the migration must see the old running checkout and its defaults. Back up the card/data as part of the deployment procedure; this lane has not accessed the real Pi.

The service verifies root ownership and non-writable ancestors of `/usr/local/libexec/cool-eva-prune-captures`, then installs its no-argument sudo rule. It runs a fixed, non-mutating stdin probe through `sudo -n -u #<checkout-owner-uid> -- sudo -n <helper>`. This is the real-Pi check for `sudo -n` stdin (including Bookworm `use_pty`); it must succeed before any rename. A group-writable `/usr/local` (for example `root:staff 2775`) fails closed. An administrator must deliberately protect the helper's ancestors before retrying; the service does not change a system-wide prefix's ownership or permissions. Local fixture checks cannot claim to have verified this Pi.

## First start after pulling this branch

1. Before sensors, CAN/OBD polling, hub enrolment, recording or diagnostic/archive writers start, the process acquires the shared settings lock. It captures only recognised names from **its own effective environment**, including the old unit's environment file and drop-ins. It durably saves the canonical private document **before publishing any move journal**, so a power cut cannot require a second environment import.
2. Explicit choices retain their old meaning. An unset coolant choice intentionally becomes OFF; explicit ON stays ON. An explicit automatic-current OFF stays OFF; otherwise its permission is ON. The recording recipient, configured Bluetooth key, custom-BMS answer and installed fan choice carry over. A private key in the old public-key file is converted to its public half, with the specific visible warning; it never stops otherwise working recording.
3. The service installs/verifies the capture-pruner prerequisite above and stops `can-capture`. It checks all four source trees before any rename. Links, hard links, special files, in-code overrides, conflicting destinations or a cross-filesystem move leave source data intact and report a fault. A refusal before journal publication resumes the intact capture writer. The [single journal and layout](data-layout.md) govern the move of default ride logs, service data, Wi-Fi dumps and captures to `/var/lib/cool-eva`. Same-filesystem renames preserve bytes/inodes; parent fsyncs, setgid permissions and one bounded permission sync precede completion. Explicit external archive paths stay where they are. Older history left in an unused default folder also moves to its managed archive, so later release cleanup cannot erase it. Compatibility links keep older code pointed at moved data.
4. After a successful move, it commits the archive locations and migration state, resumes captures, then starts the application with one fixed active snapshot. A cut at a persisted boundary resumes from that journal. Failed permission sync leaves a visible repair fault, pauses archive writers and blocks release cleanup; it does not silently restart-loop. A completed move never stops writers/reinstalls the pruner again just to retry a missing explicit public key.
5. CAN/OBD/E-LOCK, Wi-Fi monitoring on `wlan0`, GPS clock discipline and service-read/write availability use Daniel's new always-available policy. Existing bus safety gates and confirmations still apply; there is no new dashboard login. Automatic current reduction, if allowed, can send requests through the existing write runner. On a stock BMS Daniel expects little practical change beyond the dash's maximum-current request. Existing NetworkManager profiles and credentials are untouched in this phase.

## What Daniel sees

The dashboard's first open shows the one-time **What changed on this Pi** summary. An unset coolant install sees: **“Coolant probes are now off. Enable them in Settings → Bike setup if you have the probes installed.”** Explicit ON sees its preserved-choice message. The summary also names always-available writes, current-reduction permission, who can control the bike and discover-once hub behaviour; it remains in Settings → Advanced after dismissal.

Settings has the approved full-height map outside riding tabs and handlebar navigation. Shared changes say **Saved. Applies after restart** and **Saved, not active**, with a pending list and explicit two-tap Restart. Readings and recording pause; Bluetooth may disconnect. Restart reserves the choice revision and the shared bus across a bounded BLE drain and shutdown. A lost reply still schedules the restart; reconnect/readback reconciles using the process generation. A reservation not consumed within 30 seconds releases with a visible failure. Screen and Units remain immediate phone preferences.

Hardware state says Off, Reading, Driver ready or Unavailable; configured hardware failure is not silently turned off. The fan has no rotation sensor. CAN reports missing interface or missing recognised traffic with sleeping/wiring guidance; it does not reopen the channel. The existing confirmed CAN restart remains available. A hub learned on a migrated install's first ride is active runtime state: no pending change, revision increment or restart invitation.

Corrupt/newer settings preserve the original bytes, use safe defaults with automatic charging OFF, and show a fault on the dashboard. Missing settings after either installation marker or move journal also fault rather than re-importing old secrets. A failed migration keeps the dashboard available; a partial move suppresses archive writers until repaired. Recording without a key is explicitly unavailable; live readings still work.

## Remaining phases and recovery

Wi-Fi add/change trials are phase 3: retain the old network until confirmed over the new Wi-Fi, persist failed/interrupted trials, and prohibit candidate autoconnect/retry at later starts. No recovery AP is promised. Dashboard Bluetooth, when configured and usable by this phone, is the recovery route for wrong Wi-Fi; otherwise use a reachable saved network, the current manual installation/repair route or card repair/re-image.

The live key decoder retains its historical private-key acceptance for compatibility. The migration warns and retains only the public half; new settings submissions refuse private keys. Any eventual stricter live-loader policy remains Daniel's future decision, rather than changing recording behaviour in this cutover.
