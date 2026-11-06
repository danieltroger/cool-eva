# Development

> The following sections preserve the former README at commit `58c7eba` (2026-11-03), including dated measurements and limitations. For first installation, use the [current README](../README.md). Older validation/status claims are historical; the existing subsystem findings and current code take precedence.

## How it works

```
MAX31865 probes ─┐
                 ├─► signals (log-on-change) ─► sealed ride log ─► /dl ─► laptop ─► SQLite ─► Grafana
Korlan can0 ─────┤                            └─► live state ─► WebSocket ─► phone dashboard
  · broadcast decode (0x200, 0x203, …)         (the bike holds only a public key:
  · OBD-II poll @1 Hz (0D, 05, 42, …)            it can seal history, never read it)
  · GPS on 0x410
Energica BT hub ─┘
  · torque/power, odometer, vehicle state
```

- `src/can/` — `socket` (can0 bring-up + raw channel), `decode`/`decode-bms` (broadcast frame decoders, pure), `pack-temperature` (picks which frame owns the true pack temperature, since that depends on which BMS config is flashed), `obd` (OBD-II poll loop), `signals`/`registry` (log-on-change core).
- `src/gps/` — `decode` (the hub's GPS message, pure; shared by CAN `0x410` and the BLE link, which send byte-identical frames), `clock-gate` (whether a satellite time may be stepped to — also pure, so `scripts/check-gps-clock.ts` can replay real sequences through it), `clock` (the I/O half: reads both clocks and runs `date -u -s`, because the Pi has no RTC).
- `src/ble/` — the Bluetooth link to the Connectivity Hub: `protocol` (framing + handshake, pure), `client` (D-Bus session), `adapter` (bring-up).
- `src/sensors/max31865.ts` — the coolant probes.
- `src/storage/encrypted-log.ts` — the only persistence on the bike: sealed, append-only, write-only. Every append is flushed to the card before it counts as written, because the Pi loses power with the bike and an unflushed one comes back as NULs — [`docs/power-cuts.md`](power-cuts.md).
- `src/storage/durable.ts` — the flush recipe the four on-bike writes share.
- `src/db.ts` — SQLite schema (long/EAV: `signal` + `session` + `reading`). Now used **only on the laptop**, by `scripts/decrypt-log.ts`, to rebuild a plaintext DB from decrypted segments. `reading.ts` is a wall-clock stamp and `(session_id, seq)` is the write order; they are separate because the wall clock steps (see [Clock](diagnostics-and-checks.md#clock)), so `ORDER BY ts` is not the order the rows were written. Nothing queries the counter yet and no index covers it — it is recorded so the ordering is _recoverable_, and adding an index over 6.2 M rows is a decision for whoever first needs one.
- `src/http/` — `static` (serves `public/` from memory), `download` (`/dl`), `waypoint` (`/waypoint`), `status` (`/status`).
- `src/ws.ts` + `public/` — the live phone riding dashboard (see below).
- `src/index.ts` — wires it all together.

## No build step

`public/` is plain ES modules that the browser runs exactly as committed — deploy stays `git pull` + restart, with nothing to rebuild and no dist to go stale, and you can edit a file over ssh in the garage. The one dependency is [VanJS](https://vanjs.org) (5 kB, vendored in `public/vendor/`), which is signals over real DOM with no virtual DOM anywhere.

It is still type-checked: `tsconfig.json` sets `checkJs`, and the modules carry JSDoc types that **import the server's own `DashboardMessage` from `src/ws.ts`**. Change the wire shape and `npm run typecheck` fails — which is what stops the two drifting apart.

Bad readings are filtered rather than drawn. Across 7.6 M logged rows the bike has produced `coolant_in` at −242 °C (59 450 rows), `coolant_out` at 988 °C (40 351), `0xFFFF` cell voltages and `high_beam` reading 193 — so `public/lib/bounds.js` gates every signal against a physical range, and a rejected value shows as **sensor fault** instead of being clamped into something plausible.

## Developing it without the bike

On the Mac, with the repository's dependencies installed:

```sh
npm run simulate -- /absolute/path/to/capture.log
# Open http://127.0.0.1:8080
```

Use Safari Responsive Design Mode or Chrome's Device Toolbar at **390×844**. Resizing the Mac's Chrome window alone cannot reach phone width. Add `--port 8081` if 8080 is occupied. Ctrl-C stops playback. Select another capture by stopping and running the command with that file.

This runs the real server, HTTP/WebSocket, decoders and dashboard at 1× recorded time, looping. Inputs are absolute/date `candump -tA` text, plain or gzip. A `.zst` input is refused before startup: decompress it into a temporary directory first, for example `zstd -dc /absolute/path/capture.log.zst > "$TMPDIR/cool-eva-replay.log"`, then give that absolute output path to the command. The simulator itself never starts zstd. Raw captures remain private and read-only; none are shipped in this repository.

Every action is refused with **Disabled in the simulator: nothing is sent to a bike**. No CAN socket, OBD poller, BLE link, coolant probes, fan hardware, Wi-Fi monitoring/recovery or handlebar actions start. GPS from the recording cannot set the Mac's clock. Missing sensors remain unavailable, hardware readiness says **Off in simulator**, and recording and automatic charging are off. The recording button therefore opens Settings; a forced download attempt reports the existing generic seal failure. Replay files observed single-frame Mode-01 replies; it does not reconstruct stored diagnostic lists or service replies. Missing service reads remain not read rather than being filled with unrelated faults.

Each pass is a fresh server process. One new temporary directory per **command run** holds only simulator settings/state; it never loads personal app settings, keys or old archives. Its contents are hashed before playback and after each pass; any difference stops the loop. The next child retains the same settings instance, so unsaved Settings drafts survive. The directory is removed after shutdown. Git identity reads use `GIT_OPTIONAL_LOCKS=0` to avoid refreshing the checkout index.

At a loop boundary the WebSocket reconnects (normally a two-second delay). Settings may say **Reconnected. Active settings confirmed below.** Navigation, charts and page-session top speed persist. Trip distance may reset or become negative when the recorded odometer goes backwards; reload the page to reset those page-session counters. These are replay artefacts, not bike behaviour. Settings → Connections identifies the file, pass and original capture clock. The CAN dot uses the same 15-second traffic timeout as live operation, including recorded silences.

The source streams bounded memory, retains the full date across midnight and paces absolute capture offsets with a monotonic clock. Sub-millisecond timestamp jitter does not change the anchor; a backwards step over one second or forward step over 30 seconds re-anchors with a warning. Ordinary gaps remain. Unparsed/partial tail lines are counted; gzip truncation warns, corruption fails. The live RX filter is also applied to replay. Directionless recordings can include the Pi's own requests on 0x7E0–0x7E7; origin cannot be recovered, and Mode-01 validation rejects request/flow-control/KWP payloads.

### Constructed dashboard states

The fixture builder remains for phone-width CI and visual review of states a recording cannot supply:

```sh
node --experimental-strip-types scripts/build-service-preview.ts /tmp/cool-eva-dashboard.html
```

Open the printed file URL. This whole-dashboard page supplies deterministic missing/rejected readings and command outcomes; it is not another recorded-data server. The former reduced replay server and annotated design sheet have been removed. Keep looking at both-theme phone-width screenshots; [the check contracts and their history](diagnostics-and-checks.md#116-the-design-preview-and-the-one-thing-its-check-cannot-see) explain what automated checks cannot judge.

### Shared receive path constraints

`src/can/receive.ts` is the live SocketCAN handler and the replay consumer. Service read/write replies get first refusal in the OBD range; the sweep only consumes frames addressed to the tester, and the bus lease permits only one runner. Live kernel arrival stamps remain the only evidence of dispatch latency; replay deliberately supplies none. The 0x410 multiplex feeds both hub diagnostics and GPS/drive decoding: returning after its diagnostic reader would silently drop GPS. Pack-temperature arbitration remains outside the pure decoder because one frame cannot identify whether VCU temperatures are shifted.

The sweep consumes only frames addressed to `0xF1` — which no OBD-II reply is, since byte 0 there is an ISO-TP length nibble. Its first refusal therefore takes nothing away from the OBD poller.

Satellite time reaches the clock gate over both CAN and BLE. On the Pi, drift/corroboration guards limit clock changes; CAN itself has no authentication. Historical frames must therefore retain the decoder's fix, satellite-count, range and UTC round-trip checks. In replay the existing external-clock switch suppresses that I/O before the gate. It reports satellite-backed trust, but recording is off and waypoint saves are refused, so that ownership flag cannot manufacture a saved observation.

The step is guarded by a drift threshold and one step per five minutes, so both transports calling it at ~2 Hz is harmless. Over BLE the frames came from a session the hub had authorised, whereas anything on can0 with id 0x410 reaches here unauthenticated, and the clock stamps rows in an append-only log we can't correct in place. The decoder guards stand in for authentication; injecting on the VDB bus is a level of access with far better targets than our timestamps.

## Checking it without the bike

```bash
npm test        # about a second; no bike, no can0, no capture
```

Runs the self-checks that replay **committed** fixtures: the trouble-code transfer above, and `scripts/check-vcu-params.ts` (parameter table, request encoding, framing, the live reads, interpretation, the snapshot diff, and the KWP transport against a simulated micro). `scripts/check-button-decode.ts` replays 25 real `0x102`/`0x400` frames, plus 2 constructed ones that prove only that the decoder is self-consistent, — including the two the cruise buttons were ever recorded on, the one the fast-charge contactor closed in, the frame the right indicator lamp lit on, and the rear-brake-only frame that closed an open question in `src/can/abs.ts` — and also guards the three ways this feature could be switched off without anything else failing: `0x400` dropping out of the kernel RX filters, a button key missing from the registry, and a deadband on a 0/1 signal, which stops it logging after the first sample and does so silently. It additionally walks all 256 values byte 2 can take and asserts that the two brake bits stay on 0x20 and 0x40 respectively, because a mask edited by one drifts on a single value nobody thought to capture. `scripts/check-all-view-tiles.ts` covers which tile each signal gets on the All page, and `scripts/check-brake-lane.ts` runs the ride-summary dashboard's own Brake query against a built database, since that lane is now an OR of two log-on-change series carried forward — a shape whose obvious spelling latches to yes and never comes back down. `scripts/check-freeze-frame.ts` cross-checks Energica's 155 per-fault field shortlists against `src/diagnostics/dtc-table.ts` — a real check across two independently sourced tables, which is why it knows about the two water-pump codes they disagree on — and then replays 31 freeze-frame transfers through the reassembler and decoder — 29 of them the replies the bike actually sent, plus 2 constructed (`P0A07` and `P0514`) whose invented values exercise decode paths the captures don't reach — a zero-current open circuit, a negative int16 and int8, the ×0.1 scaling and the `(X/2)−40` air temperature. Those 2 prove only that the decoder is self-consistent; the 29 captured ones prove the wire format. The shapes the bike never sent — a refusal, a wrong-component answer, a short consecutive frame mid-transfer — are checked separately, frame by frame, rather than replayed as transfers. It also runs `scripts/generate-grafana-dtc.ts --check`, which compares the fault-code table Grafana carries inline against `src/diagnostics/dtc-table.ts` — a copy that once went stale for months without anything on screen looking wrong. CI runs the same command on every PR, so a change that breaks a decoder, the parameter table or that dashboard goes red rather than green.

`scripts/check-can-decoders.ts` covers the broadcast decoders the same way, from a handful of frames copied byte for byte out of a real capture — and then checks three things about the decoder set that replaying cannot see. The important one is the **RX filter**: `STREAM_IDS` sets the kernel's CAN filters, so an ID missing from it never reaches the decoder and there is no symptom at all — no error, no warning, just a signal that never appears, which looks exactly like a bike that never sent it. That has already cost time here once, on `0x400`. The check probes the decoder across the whole 11-bit ID space and fails if anything that decodes is missing from the filter. It also fails if a decoder emits a key with no registry entry, and if any 1/0 flag carries a deadband of 1 or more — because `|1 − 0| > 1` is false, so such a signal logs once after boot and then goes silent forever.

There is no test framework — `scripts/run-checks.ts` runs each check as its own process and fails if any of them does, which keeps them runnable by hand exactly as their own headers document. Anything that opens a CAN socket, wants root, or needs a local-only file is deliberately excluded; that list, with a reason for each, is at the top of the runner.
