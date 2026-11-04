# Reading status and fault memory

`public/lib/reading-status.js` owns freshness and fault-display policy for tiles, Ride and Cooling. A rejected newest sample is a fault until a valid sample follows it. After recovery, a rejection stays visible for `FAULT_MEMORY_MS` (60 seconds) from its server timestamp, so one bad sample in a fast stream is still visible. An old stored rejection does not keep a recovered sensor faulted forever. The store retains the rejection for diagnostics.

Fault and reading timestamps both come from the Pi. Comparing a rejection to this phone's Date.now() measures the gap between two machines, rather than the age of the fault. The policy samples server time with peekServerTime(), and the slow chart pulse lets a recovered reading expire its fault memory without subscribing to every WebSocket patch. Chart bindings request sampled status and keep their existing slow pulse.

Freshness is independent of fault memory. Registry onDemand readings retain their last-change timestamps across snapshots, so their presence and the live link establish availability. Measured sensors retain age checks. The generated registry list prevents a future measured fan sensor inheriting an exemption from its name.

Units qualify numeric values only. Paired readings share one unit after the last numeric reading; a fault or stale word never carries °C, kW or %. Edge descriptions use the same distinction.

The browser regression pauses preview deliveries and sends actual DashboardMessage fixtures with an advanced server clock. It checks rejected → valid at 100 ms → valid just before 60 seconds → valid after 60 seconds, without shortening the production constant. It also leaves a newest rejection past the memory window to prove that persistent faults never expire into the last good value. Both Ride and Cooling, including FanStatus, follow the same policy.
