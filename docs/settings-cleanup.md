# Settings and Bike cleanup

The cleanup removes Motorcycle connection and Bike data / CAN adapter from Settings → Connections, including their visible Scan and Restart controls. Existing backend discovery and CAN behavior are unchanged. The Connections summary is Wi-Fi · Bluetooth. Setting values use left alignment and each Bike setup control has its own adjacent help disclosure.

Bike uses the short Bike history heading and a one-line service date. Empty, implausible or malformed service stamps show `fault`; an unavailable stamp shows `—`. The original stamp, raw-word interpretation and the 2026-09-08 zero reading remain documented in [service-stamp.md](service-stamp.md). Lifetime derivations and rejected scaling remain in [lifetime-battery-statistics.md](lifetime-battery-statistics.md); their detail is available in reading titles rather than inline paragraphs.

The removed empty-history prose previously led with an in-app read path and then offered a stopped-service shell command. Both remain in the lifetime HTTP response for diagnostic clients; the phone page uses its local read control. Its read still parks the OBD poller and keeps its existing arm/dwell and server gates.

Download all ride logs performs the existing flush/download action, including when current recording is off. An action-looking download button no longer navigates to Settings. The endpoint concatenates saved sealed logs; the label does not imply only the current ride.

## Current Settings scope

The [inline Settings page](settings-batch.md) replaces the subpages and per-field saves with one draft and one Save/Cancel row. It uses existing settings only. Recording readiness and folders are read-only; public-key replacement and the existing global automatic-current permission remain available. There is no independent recording switch or per-phone control preference.

The hotspot name remains a connection-monitoring choice. It does not provision Wi-Fi. Network/password editing will reuse #337 after its real-network acceptance, preserving its trial/rollback behavior and applying that change last in a shared Save.

The former raw-stamp formatter header recorded why raw words mattered: the server phrases the decoded outcome, while the audit journal records the decoded date and odometer rather than all four raw words. On the first 2026-09-08 read those words were not retained in the journal or page. The diagnostic formatter remains available; [service-stamp.md](service-stamp.md) preserves the complete evidence and market-dependent odometer-unit limitation.

The HTTP diagnostic hint now names More → Bike and the current Read bike history control. The CLI command remains separate and its parser is still tested. Historically #177 moved the read into the app while the empty-state instruction still named a shell command; #187 separated the two. The app no longer prints either hint. The comma in the diagnostic precondition remains intentional: parked AND (drive down OR plugged in), rather than allowing a moving bike on a cable. Charging-gate reasoning remains in [vcu-parameters.md](vcu-parameters.md) §12.

The Bike setup readiness lines predate this PR: Settings phase 2 (#336, commit `8c1062f`) placed `Readiness("coolant")` and `Readiness("fan")` beside their cards. PR #378 initially retained that arrangement. The review correction moves each readiness binding inside its own card and omits it when it repeats the active choice; distinct probe diagnostics and fan driver/rotation status remain visible there.
