# Headlights and charging — a physical interlock, not a CAN command

Findings for the beam signals on `0x102` (`high_beam` b0 bit6, `high_beam_lamp`/`low_beam_lamp` b2 bits 0/1) as they behave around a charge session. The bit-level identification lives in [can-decode-findings.md](can-decode-findings.md) (§b0/b2, the 1 103 000/1 103 000 switch↔lamp agreement); this file records what the beams do when a charger is plugged in.

## The question

Can the headlights be turned off by asserting something on the CAN bus? Two motivations: there is no headlight-control message anywhere in the decoded map, but the bike is _observed_ to kill the headlights whenever a charger is connected — so if that cutoff were triggered by a charge frame the VCU broadcasts, asserting that frame might reproduce it.

**Answer: no.** The cutoff is a physical/electrical consequence of the cable being present, upstream of and time-decoupled from every charge signal on the bus. The charge frames are neither the cause nor able to hold the lights off.

## The evidence — one AC session, both edges

Captured live 2026-08-25 (session 14 in the ride log), reconstructed in write order `(session_id, seq)` by `scripts/check-headlight-charge.ts`. `key_on` stayed `1` throughout — the key was never turned off, so nothing here is a key-off effect.

**Plug in** — lights die _before_ any charge signal appears:

    01:45:42.739  high_beam = 0        SWITCH input drops to 0
    01:45:42.739  high_beam_lamp = 0   lamp follows, SAME millisecond
    01:45:43.306  charge_manager_state = 2   charge-manager ECU appears (+567 ms)
    01:45:48.138  charge_state = 2           AC current actually flowing (+5.4 s)

**Unplug** — lights return _long after_ the charge signals have cleared:

    01:58:07.496  charger_enabled = 0    stop-charging command lands
    01:58:10.186  charge_state = 1       CAN says: not charging
    01:58:17.042  charge_type = 0        charge session cleared
    01:58:18.791  high_beam = 1          SWITCH reads high again — LIGHTS BACK ON
    01:58:18.791  high_beam_lamp = 1     lamp follows, same millisecond

On plug-in the beams drop **~0.6 s before** the first charge-manager frame; on unplug they return **~8.6 s after** `charge_state` had already gone back to `1`. On both edges the beam state tracks the **physical cable**, and the charge messages are offset from it — leading at connect, lagging at disconnect. The user's account matches exactly: stop command → bike prompts "ok to disconnect" → cable pulled → ~1 s later lights on.

## Why this rules out a CAN cause

- It is the handlebar `high_beam` **switch input** that flips (b0 bit6), with the lamp output (b2 bit0) following in the same millisecond — the same lockstep as everywhere else in the corpus. The VCU is not cutting the lamp driver while leaving the switch; the whole switch/light circuit is **de-powered by cable insertion and re-powered by removal**. The VCU cannot move a physical switch, so a read of `0` on the switch line means that line actually lost power.
- The charge-manager frames are a **downstream announcement**: at plug-in they arrive after the lights are already out, and at unplug they had cleared 8+ seconds before the lights came back. Asserting them onto the bus would not reproduce the cutoff.

So: **no _charge_ frame and no _broadcast status_ bit turns the headlights off.** The `0x102` beam bits are read-only telemetry, and the charging→lights-off behaviour is a hardware interlock on cable presence, not a message.

⚠️ **The diagnostic channel _can_ turn the headlight off — confirmed on-bike (2026-08-27).** A UDS `0x2F` InputOutputControl to VCU-Safety (`io_set` control 17 → 0) forces the beam off; verified by eye. The catch is that the override is a short pulse that decays in well under 40 ms, so it must be re-asserted on a tight (~5 ms) loop to hold the light dark — a single force just makes it blink. This is the _diagnostic_ channel, still not any broadcast frame, so the conclusion above stands. Full results and the recipe are in [headlight-diagnostic-control.md](headlight-diagnostic-control.md).

## Confidence and how to extend it

This is **n = 1 session, two edges**. It is consistent and both transitions point the same way, but it cannot yet distinguish "plugging in de-powers the light circuit" from a rider coincidentally toggling the switch at connect and disconnect — the two-edge timing makes coincidence unlikely but not impossible. To confirm, capture more charge sessions and re-run:

    node --experimental-strip-types scripts/decrypt-log.ts <blob> --out rides.db
    node --experimental-strip-types scripts/check-headlight-charge.ts rides.db

The signature to look for, repeated every session: `high_beam`+`high_beam_lamp` → 0 leading the charge-manager frames at connect, and → 1 lagging `charge_state = 1` at disconnect, with `key_on` staying `1` throughout.
