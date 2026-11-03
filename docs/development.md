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

```bash
node --experimental-strip-types scripts/replay-capture.ts <capture.log> --speed 4 --skip 60
# → dashboard on http://localhost:8080, fed by the real decoders
```

Replays a `candump -tA` capture through the actual decode path, so what's on screen has taken the same route it does on the Pi.

The captures this was developed against are one motorcycle's ride history and aren't in the repo, so you'll need your own: `candump -tA can0 > capture.log` on the Pi while the bike is awake, and anything from a few seconds up will do. `scripts/decode-dtc-response.ts` does run standalone — it replays a real, committed trouble-code transfer and needs no capture at all.

## Checking it without the bike

```bash
npm test        # about a second; no bike, no can0, no capture
```

Runs the self-checks that replay **committed** fixtures: the trouble-code transfer above, and `scripts/check-vcu-params.ts` (parameter table, request encoding, framing, the live reads, interpretation, the snapshot diff, and the KWP transport against a simulated micro). `scripts/check-button-decode.ts` replays 25 real `0x102`/`0x400` frames, plus 2 constructed ones that prove only that the decoder is self-consistent, — including the two the cruise buttons were ever recorded on, the one the fast-charge contactor closed in, the frame the right indicator lamp lit on, and the rear-brake-only frame that closed an open question in `src/can/abs.ts` — and also guards the three ways this feature could be switched off without anything else failing: `0x400` dropping out of the kernel RX filters, a button key missing from the registry, and a deadband on a 0/1 signal, which stops it logging after the first sample and does so silently. It additionally walks all 256 values byte 2 can take and asserts that the two brake bits stay on 0x20 and 0x40 respectively, because a mask edited by one drifts on a single value nobody thought to capture. `scripts/check-all-view-tiles.ts` covers which tile each signal gets on the All page, and `scripts/check-brake-lane.ts` runs the ride-summary dashboard's own Brake query against a built database, since that lane is now an OR of two log-on-change series carried forward — a shape whose obvious spelling latches to yes and never comes back down. `scripts/check-freeze-frame.ts` cross-checks Energica's 155 per-fault field shortlists against `src/diagnostics/dtc-table.ts` — a real check across two independently sourced tables, which is why it knows about the two water-pump codes they disagree on — and then replays 31 freeze-frame transfers through the reassembler and decoder — 29 of them the replies the bike actually sent, plus 2 constructed (`P0A07` and `P0514`) whose invented values exercise decode paths the captures don't reach — a zero-current open circuit, a negative int16 and int8, the ×0.1 scaling and the `(X/2)−40` air temperature. Those 2 prove only that the decoder is self-consistent; the 29 captured ones prove the wire format. The shapes the bike never sent — a refusal, a wrong-component answer, a short consecutive frame mid-transfer — are checked separately, frame by frame, rather than replayed as transfers. It also runs `scripts/generate-grafana-dtc.ts --check`, which compares the fault-code table Grafana carries inline against `src/diagnostics/dtc-table.ts` — a copy that once went stale for months without anything on screen looking wrong. CI runs the same command on every PR, so a change that breaks a decoder, the parameter table or that dashboard goes red rather than green.

`scripts/check-can-decoders.ts` covers the broadcast decoders the same way, from a handful of frames copied byte for byte out of a real capture — and then checks three things about the decoder set that replaying cannot see. The important one is the **RX filter**: `STREAM_IDS` sets the kernel's CAN filters, so an ID missing from it never reaches the decoder and there is no symptom at all — no error, no warning, just a signal that never appears, which looks exactly like a bike that never sent it. That has already cost time here once, on `0x400`. The check probes the decoder across the whole 11-bit ID space and fails if anything that decodes is missing from the filter. It also fails if a decoder emits a key with no registry entry, and if any 1/0 flag carries a deadband of 1 or more — because `|1 − 0| > 1` is false, so such a signal logs once after boot and then goes silent forever.

There is no test framework — `scripts/run-checks.ts` runs each check as its own process and fails if any of them does, which keeps them runnable by hand exactly as their own headers document. Anything that opens a CAN socket, wants root, or needs a local-only file is deliberately excluded; that list, with a reason for each, is at the top of the runner.
