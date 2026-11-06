# Reading status and fault memory

`public/lib/reading-status.js` owns freshness and fault-display policy for tiles, Ride and Cooling. A rejected newest sample is a fault until a valid sample follows it. After recovery, a rejection stays visible for `FAULT_MEMORY_MS` (60 seconds) from its server timestamp, so one bad sample in a fast stream is still visible. An old stored rejection does not keep a recovered sensor faulted forever. The store retains the rejection for diagnostics.

Fault and reading timestamps both come from the Pi. Comparing a rejection to this phone's Date.now() measures the gap between two machines, rather than the age of the fault. The policy samples server time with peekServerTime(), and the slow chart pulse lets a recovered reading expire its fault memory without subscribing to every WebSocket patch. Chart bindings request sampled status and keep their existing slow pulse.

Freshness is independent of fault memory. Registry onDemand readings retain their last-change timestamps across snapshots, so their presence and the live link establish availability. Measured sensors retain age checks. The generated registry list prevents a future measured fan sensor inheriting an exemption from its name.

Units qualify numeric values only. Paired readings share one unit after the last numeric reading; a fault or stale word never carries °C, kW or %. Edge descriptions use the same distinction.

The browser regression pauses preview deliveries and sends actual DashboardMessage fixtures with an advanced server clock. It checks rejected → valid at 100 ms → valid just before 60 seconds → valid after 60 seconds, without shortening the production constant. It also leaves a newest rejection past the memory window to prove that persistent faults never expire into the last good value. Both Ride and Cooling, including FanStatus, follow the same policy.

## BMS multiplex holds

The 81 cell voltages and 31 fitted module temperatures rotate through 0x662–0x664. They are measured readings, with bounded display holds rather than onDemand exemptions. Registry display-freshness metadata generates the exact key-to-class map; other LMU signals retain the ordinary eight-second rule. Each class has one named constant in reading-status.js:

| Class                              | Readings | Maximum age |
| ---------------------------------- | -------: | ----------: |
| Cells 1–3 in each module (0x662)   |       33 |        15 s |
| Cells 4–8 (0x663/0x664)            |       48 |       715 s |
| Fitted module temperatures (0x664) |       31 |      1570 s |

A reading is available only within its own age budget, while `lmu_cell_mux` is within the ordinary 8 s limit and the phone link is live. A missing sensor remains missing; physical-range rejection remains a fault. All 0x66x frames stopping expires every held reading after the carrier's last timestamp exceeds 8 s, even if other traffic and WebSocket heartbeats continue. Carrier recovery makes still-within-budget values available again. Partial loss of only 0x663 or 0x664 can retain that frame's readings until their class budget expires because the other frames share the carrier. Even an invalid selector emits the carrier; it cannot renew individual readings.

The server already retains the last real sample and refreshes its timestamp on every decoded arrival, independently of logging deadband. Browser snapshots preserve those timestamps. Repeating an old reading in a heartbeat cannot renew it. The selector's deadband of 100 normally suppresses selector-change patches, so refreshed carrier timestamps reach the browser through five-second heartbeat snapshots. Expiry is observed on the next message/render pulse; network delay does not change server-versus-server age.

Pack low/high, weakest/strongest BMS indices and spread come from the BMS's simultaneous 0x203 summary, under ordinary bounds and freshness. They never fall back to independently aged held cells. BMS indices are not translated into physical positions. All held cell bars/numbers and module heatmap/numbers remain visible within budget. The provisional `readingCanColour()` predicate restricts colour to samples within the ordinary eight-second window; older held samples draw neutrally. A current cell above the current BMS maximum has no gap, not a fault. Bar geometry fits the displayed readings without making their extrema pack summaries.

### Historical raw-arrival measurement

The calibration analyzed 275 uncompressed raw logs (14.98 GB) from the archived rides and later CAN captures, selected by largest copy for duplicate basenames. Exact timestamp/ID/payload deduplication left 4,555,078 unique 0x662/663/664 frames; 110,496 duplicates were removed. Ninety-five files contributed unique BMS frames. The pure decoder counted only valid arrivals for all 81 cells and 31 fitted temperatures. Log-on-change database intervals cannot measure arrival frequency and were not used.

A complete coverage pass starts with its first valid arrival, ends when every expected key has arrived, then resets. File boundaries, mode changes, backward clock steps and gaps over two seconds break passes; incomplete passes are not counted. Fresh charge-manager state/inlet evidence and AC-charger frames classify charge sessions; otherwise fresh speed separates moving (>1 km/h) from parked. Missing context and uncertain-clock cohorts are excluded below. Percentiles use empirical nearest rank.

| Mode       | Family          | Passes | p50 (s) | p95 (s) |  p99 (s) |  Max (s) |
| ---------- | --------------- | -----: | ------: | ------: | -------: | -------: |
| Moving     | 81 cells        |    132 | 170.093 | 376.017 |  475.392 |  608.668 |
| Moving     | 31 temperatures |     77 | 269.415 | 636.733 |  782.309 |  782.309 |
| Parked     | 81 cells        |     36 | 159.472 | 361.437 |  395.993 |  395.993 |
| Parked     | 31 temperatures |     23 | 193.516 | 397.101 | 1044.548 | 1044.548 |
| AC session | 81 cells        |    367 |  74.258 | 141.149 |  212.003 |  248.812 |
| AC session | 31 temperatures |    224 | 100.131 | 287.146 |  488.441 |  565.754 |
| DC session | 81 cells        |    155 |  76.515 | 181.706 |  226.166 |  271.081 |
| DC session | 31 temperatures |     97 | 105.147 | 334.478 |  552.754 |  552.754 |

These are the August 7–September 18 cohort, separated from earlier captures, some of which ran phase-locked or other configurations. No later raw source was available, so this does not establish November rotation times or prove a specific flashed configuration. Mode changes censor long passes and can bias tails downward; small samples (especially 23 parked-temperature passes) cannot establish a population p99. Conflicting short overlapping/replayed clips were not allowed to replace the long-tail calibration. Thirteen clock discontinuities were separated.

Daniel approved 1.5× the worst-mode empirical p99, rounded up to five seconds: 15/715/1570 s. The fast 0x662 all-11-selector p99 ranges from 6.860 to 9.412 s; cells 4–8 dominate whole-pack coverage. Independent rolling-cover maxima of 578.390 s for cells and 1155.690 s for temperatures corroborate the slow budgets. An observed fast-class revisit tail of 19.6 s plus heartbeat lag can still cause rare stale blips at 15 s. These are bounded holds, not a promise that every reading always stays visible.

In the latest 90-second DC clip, the first full valid cell/temperature passes took 56.281/69.344 s. During its last 30 s, an eight-second allowance showed 37–66 cells and 3–20 temperatures; neither eight nor fifteen seconds ever showed all 81/31. Frame rates of about 20/6.67/4 Hz do not imply full-pack coverage at those rates: repeated selectors refresh only their own module. Re-measure after a faster configuration before shortening the three constants. Reproducible scan/results remain private; no raw traces or local paths are published.

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
