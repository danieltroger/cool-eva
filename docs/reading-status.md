# Reading status and fault memory

`public/lib/reading-status.js` owns freshness and fault-display policy for tiles, Ride and Cooling. A rejected newest sample is a fault until a valid sample follows it. After recovery, a rejection stays visible for `FAULT_MEMORY_MS` (60 seconds) from its server timestamp, so one bad sample in a fast stream is still visible. An old stored rejection does not keep a recovered sensor faulted forever. The store retains the rejection for diagnostics.

Fault and reading timestamps both come from the Pi. Comparing a rejection to this phone's Date.now() measures the gap between two machines, rather than the age of the fault. The policy samples server time with peekServerTime(), and the slow chart pulse lets a recovered reading expire its fault memory without subscribing to every WebSocket patch. Chart bindings request sampled status and keep their existing slow pulse.

Freshness is independent of fault memory. Registry onDemand readings retain their last-change timestamps across snapshots, so their presence and the live link establish availability. Measured sensors retain age checks. The generated registry list prevents a future measured fan sensor inheriting an exemption from its name.

Units qualify numeric values only. Paired readings share one unit after the last numeric reading; a fault or stale word never carries °C, kW or %. Edge descriptions use the same distinction.

The browser regression pauses preview deliveries and sends actual DashboardMessage fixtures with an advanced server clock. It checks rejected → valid at 100 ms → valid just before 60 seconds → valid after 60 seconds, without shortening the production constant. It also leaves a newest rejection past the memory window to prove that persistent faults never expire into the last good value. Both Ride and Cooling, including FanStatus, follow the same policy.

## Server group liveness

A stored event timestamp measures its last change, not the health of a quiet source. Waypoint and fan groups consist entirely of onDemand signals; the normal resting waypoint state must not look dead just because no waypoint was saved recently. Their group summaries omit liveness. Charge mixes periodic samples and held events, so it keeps its normal liveness summary. Exemption is deliberately whole-group: using some() would exempt every periodic signal as soon as one held event joined the group. check-ride-log-status.ts §5b pins that distinction with a synthetic mixed group.

Earlier rationale from the implementation (the obsolete claim that no mixed groups existed is corrected above):

```text
/**
 * Groups every one of whose signals is written on request, so the group is left out
 * of the summary above entirely.
 *
 * `waypoint` was the case that forced this: it reads [0, 3]
 * before you ever save a waypoint and [0, 3] again ten seconds after you do, so
 * anything filtering `live === 0` would fire on the resting state forever and learn
 * nothing. Silence that is not evidence should not be served as if it were.
 *
 * ⚠️ WHOLE-GROUP, not per-signal, and that is a decision rather than an accident:
 * `.some` here would delete a whole group's liveness the moment one signal in it
 * were flagged. Charge is already mixed; §5b of scripts/check-ride-log-status.ts also
 * feeds this function a synthetic mixed group to pin the all-signals rule.
 */
```
