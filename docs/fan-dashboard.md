# Fan dashboard

The approved Cooling view owns the fan percentage, Auto/Manual buttons and manual slider. Hardware settings hide the card when the fan is not installed. An active fun mode selected on the bike still reports its state; the phone has no control for entering it.

The client state and transport live in `public/lib/fan-control.js`; `public/views/fan.js` renders them. Cooling reads on entry. The existing command queue allows one request in flight, one latest command waiting and at least 150 ms between sends. Controls move immediately. An older reply cannot overwrite a newer pending mode or duty. A successful read with no command outstanding clears delivery uncertainty.

The slider stays mounted during updates. Its value is an index into the server-provided stop list: zero, then the running floor through the maximum. This removes the rejected dead zone below the running floor. Without a reply its stop list is inert, rather than guessing a cap. The thumb follows the live target in automatic/fun mode and the pending choice in manual mode. It follows `fan_target_pct`, not actual duty: kick-start briefly drives 100%, which must not snap the thumb away from the requested speed.

Commands retain the `X-Cool-Eva: fan` header. The query spelling for the automatic mode is `mode=auto`; the typed reply calls it `automatic`. A duty command already selects manual mode. The mode spelling table is exhaustive over the server's `FanMode` type. Refused commands and failed requests are logged. A request without a response may already have reached the GPIO, so the status remains unavailable until a later confirmed command or read.

The one status line retains unavailable/fault, standby, braking, failed-stop and kick-start states. It reads live signal quality, including the 60-second fault memory, rather than treating the last HTTP reply as a live sensor. Steady fan command timestamps do not expire on a live link; real temperature inputs retain their age gate. A zero-duty enabled bridge is a braking fault, and an active bridge after a requested stop is a failed stop. Automatic temperature failures remain faults.

## Inline feedback and announcement memory

While Cooling is visible, its fan percentage and status line own feedback for mode and duty changes. Fan banners are suppressed there, preserving the header and top switch and avoiding a repeated percentage. The announcement fold still remembers each change, including its off-state, so leaving Cooling cannot replay it. Other screens retain fan announcements; waypoint and Wi-Fi announcements keep their existing behavior.

This samples the visible route rather than guessing whether a change came from this phone. The live patch normally precedes the HTTP reply, so tracking the request's origin would require a timing window that can swallow a real handlebar event. The inline exception depends only on the existing visible fan control.

The announcement fold stays pure and shared with the real watcher and the fan-banner checks. The former replica in the hold-gesture check fed the same percentage to both key and text, asserting a pair that could never disagree; it stayed green through #199, where mode and duty arrived separately and the banner named the previous duty. Keeping the real fold and ordered patch tests preserves that finding while changing presentation.

## Preserved constraints from the former menu view

The fan moves a GPIO on the Pi, not the motorcycle's CAN bus. It has no motorcycle arm/confirm gate: the next command reverses the change, and watching the fan while dragging is the intended interaction. The manual control remains live on `input`; only transport is paced, so the Pi does not spawn a GPIO write for every thumb event.

The running floor, cap, kick-start duration and temperature curve belong to the Pi. The client reads limits from `/fan`; it does not duplicate policy. A Pi without the fan endpoint returns 404 when `FAN_ENABLED` is unset. Full bridge operation, temperature selection and throttling findings remain in [fan-control.md](fan-control.md).

Fun mode is still gated by the server's fresh parked/throttle checks. The old phone button's `fan_fun_available` signal was only an indication of availability, never permission: the server rechecked before entering. Live `FAN_MODE_CODE` values, rather than a local 1/2 assumption, reflect the server ending fun mode as soon as the bike can move. The former mode button, fun-mode button, gate prose and slider caption are retired by the approved sketch.

The retired menu slider used a custom amber 30.4 px thumb on a 44 px input target, to distinguish a manual GPIO write from the green automatic state. Its mode button was 60 px high and shared a row with the slider. The approved Cooling sketch replaces that skin with two 44 px mode buttons and a separate native green range input, still in a 44 px target. The previous cross-browser CSS deliberately kept WebKit and Firefox pseudo-elements in separate rules: grouping unsupported pseudo-elements discards the whole selector list. No vendor pseudo-element rules remain in the current native slider.
