# Dash command `0x2C` — the SOC charge limit ("stop charging at N %")

The bike's own charge limit, on the non-diagnostic VCU command channel described in [dash-command-channel.md](dash-command-channel.md). Request on `0x120`, reply on `0x121`; b0 is a 7-bit command id plus bit 7 (**set = write, clear = read**), b1 is the `0xFF` separator, b2 is the percentage 1:1, and **0 means no limit**.

⚠️ Write `0x2C` as _dash command `0x2C`_, never as a bare `0x2C`: on this bus `0x02C` is `DRIVE_TORQUE_CAN_ID` (`src/can/drive.ts`) and `0x2C` is also a KWP service. Three meanings, one string.

Read and written on-bike 2026-09-19: **80 → 90 %**, read back twice from the VCU's own store.

## What the frames are

| what            | id      | bytes                                              |
| --------------- | ------- | -------------------------------------------------- |
| read            | `0x120` | `2C FF 00 00 00 00 00 00`                          |
| write N %       | `0x120` | `AC FF <N> 00 00 00 00 00` (`0xAC = 0x2C \| 0x80`) |
| the VCU's reply | `0x121` | `2C FF <stored> 00 00 00 00 00`                    |

`src/can/charge-soc-command.ts` builds the two requests, `src/can/charge-soc-limit.ts` decodes the reply into `charge_soc_limit_pct`, and `src/vcu/charge-soc-limit.ts` is the round trip.

## The encoding, from the bike's own menu

Three `0x2C` events exist in the whole local capture archive, all of them the rider confirming the bike's own menu item, and they are what the percentage reading rests on:

```
2026-08-02 21:02:15.795230  120  AC FF 28 …   ← 40 %, while SOC read 39 % on a live 1 A AC charge
2026-09-19 16:56:23.061347  120  AC FF 00 …   ← 0 (no limit): the value the menu stood at
2026-09-19 16:56:31.189895  120  AC FF 50 …   ← 80 %
```

The 2026-08-02 one is the best of the three: `0x200` b1 read `0x27` = 39 % at that instant, so the rider was setting the limit one point above where the pack already was. `docs/can-decode-findings.md` also records a `0x2C` carrying b2 = `0x4B` = 75, from a capture not in the local archive.

**It is emitted on the menu's confirm, not on the scroll.** Between the two 2026-09-19 frames there are **ten button presses** on `0x102` b0 bits 0/1/2 — 4 left, 2 right, 4 enter — and only the last enter produced a frame, 1.474 ms later (the first frame followed its enter by 3.506 ms). So three of those four enters put nothing on this channel: enter is necessary, not sufficient.

**Nothing broadcasts the limit.** Scanning 16:54:31–16:58:31 across `capture-20260919-165030-…` and `capture-20260919-165614-…` — 74 ids, 585 (id, byte) positions — the only position that is constant before the change and constant-but-different after is `0x121` b2 itself. Byte-aligned only: a limit carried in a nibble, scaled, or multiplexed would not show.

## The read is the VCU's stored value, not an echo

The request carries `b2 = 0` and the reply comes back with the stored percentage, so the reply cannot be a reflection of what was asked. Measured twice over: the 2026-08-27 sweep asked `0x18` with b2 = 0 and was answered 60, and on 2026-09-19 a `2C FF 00` request was answered `2C FF 50`.

**Reads do not mutate.** Two reads a second apart on 2026-09-19 both returned 80, either side of nothing. That matters because the archive leaves a gap — the limit read 40 on 2026-08-02 and 0 at the 2026-08-27 sweep — and "the sweep's own read zeroed it" was a live explanation until this test. It is now dead for `0x2C`; the rider having cleared it in those 25 days is what is left.

⚠️ The non-mutating claim for the _other_ 127 ids is still second-hand. It comes from `scripts/dash-command-sweep.ts`, which credits a third-party document that is not on this machine. Nobody in this chain has read it.

## The reply carries no min/max

`0x18` answers `3c 01 4b`, which reads equally well as _value 60, min 1, max 75_ or as _value, limit-in-force, ceiling_ — the repo says both, in [dash-command-channel.md](dash-command-channel.md) and `src/can/charge-setpoint.ts`, and **the archive cannot separate them**: all 105 archived current-limit replies carry `b3 = 0x01`, which both readings predict.

`0x2C` needs no answer to that question. Its replies are `2C FF <pct> 00 00 00 00 00` — b3 through b7 zero in **all ten observations**: the three archived dash frames, and the seven replies of 2026-09-19 (six answers to bit-7-clear reads, plus the bike's answer to the write). So it states no range at all, and the control is bounded by a declared 0–100 rather than by anything the bike says.

## One frame, not the pair — the `0x121` is the bike's answer

The archived events look like pairs, `0x120` then `0x121` a few ms later. **They are not two halves of a command.** On 2026-09-19 this Pi sent the `0x120` write _alone_ and the capture shows a `0x121` appearing 7.66 ms later that nothing on the Pi transmitted:

```
22:53:07.893493  120  2C FF 00 …   ← the read-before
22:53:07.895079  121  2C FF 50 …   ←   answered in 1.59 ms: still 80
22:53:07.900690  120  AC FF 5A …   ← the write, and the ONLY frame we sent for it
22:53:07.908354  121  2C FF 5A …   ←   the BIKE's answer, 7.66 ms later — we sent no 0x121
22:53:07.941532  120  2C FF 00 …   ← the read-back
22:53:07.944784  121  2C FF 5A …   ←   answered in 3.25 ms: 90
```

So `0x120` carries every request and `0x121` carries every reply, and injecting a `0x121` would spoof a VCU→dash reply rather than complete a command. That is exactly the mechanism behind [can-0x121-charge-command.md](can-0x121-charge-command.md)'s "the display moved and the setpoint did not", and it is why `buildChargeSocLimitWrite` returns one frame.

⚠️ **This corrects a shipped comment.** `scripts/dash-command-write.ts` said _"the VCU emits no 0x121 ack for an injected 0x120 write"_. It does — 7.66 ms later, byte for byte the value written. The 2026-09-09 finding in [can-0x121-charge-command.md](can-0x121-charge-command.md) was right and that comment was wrong.

### Reply latency, and where the slow first read actually was

The bike answers in **1.310–7.664 ms**, mean 3.672 — the seven exchanges of 2026-09-19, measured request-to-reply off the capture: 5.543, 3.319, 1.586, 7.664, 3.252, 1.310, 3.033 ms. Never slow, and straddling the 4.217–10.122 ms window the dash's own exchanges occupy. The probe that reported a "99 ms cold read" was measuring **its own send path**: it stamped 20:52:04.528Z before `channel.send`, and the kernel put the frame on the wire at 22:52:04.611064 CEST — 83 ms later, on a Pi Zero 2 W with a cold code path. The bike then answered in 5.54 ms. Measure this channel's latency from the capture, not from the sender.

## What is proven, and what is not

✅ The VCU **stores** the value. Written 90, read back 90 by two independent programs, the second 18 s later — well past the 40 ms settle, so not a pending display value.

❌ That the bike **stops** at that percentage is **not proven**, and nothing in this repo has ever observed the limit being reached: the 2026-08-02 capture ends **6.125 s** after SOC reached its 40 % limit (39 → 40 at 21:07:52.970126, the last `0x300` still `charger_enabled = 1` at 21:07:59.095608) and the following capture is a different boot with a stepped clock. Only a charge that gets there settles it. Every message the dashboard shows says so rather than implying a guarantee.

## The signal, and its three sources

`charge_soc_limit_pct` (`src/can/registry.ts`, bounds 0–100) is an **event**, like `dc_charge_limit_selected_a` beside it — nothing rebroadcasts it, so an absent value means "not asked and not touched", never "no limit". It arrives from **three** sources, and the third is the one that has bitten this repo before (`src/charge/auto.ts`, #186):

1. the rider confirming the menu item on the bike,
2. this Pi reading it,
3. **the bike answering this Pi's own write**, ~6 ms later.

Nothing in the first version consumes it as rider intent, so the third is harmless here — but it is written down because the next reader may want to.

## Gating

**Daniel's ruling, 2026-11-06:** reading and setting the stored SOC charge limit are allowed in drive and while moving because this setting only affects when charging stops. Only `charge-soc-limit` and `charge-soc-limit-read` change their `serviceActionPolicy().bikeStateGateApplies` flag to false; parameter writes, resets and every other policy retain their gates and watchdogs.

The Set operation now requires its existing pre-read to receive a new reply before it can send the mutating 0xAC frame. A timeout or refused read transmit is audited/refused with “no limit was sent”; a cached earlier reply cannot satisfy that read's monotonic mark. An answered zero is valid. The final independent read-back still distinguishes written, mismatch and unverified. Permission/settings health, active CAN, the service-write header/JSON barrier, the bus lease and value-bound Set confirmation remain required. No private fast-DC liveness signal is added.

Controls reads once on each actual page entry, with no Read button or arming. It reuses held permission, joins a real pending status GET from either owner, or fetches only when neither exists; it never fetches mid-gesture. Explicit session/settle/arm refreshes retain their existing ownership. Session end abandons the prior generation; its late result cannot clear a live request. Before the opening read's first await, only raw values/peek and the entry token are touched, avoiding VanJS dependencies in the app's view binding. Permission and route checks after the await prevent a delayed read on another page. Replies, heartbeats and permission changes do not start another read. The opening read adds an audit line and may hold the lease for the 500 ms reply window; an automatic-current tick can be refused once. There is no lease exception or automatic read retry.

A former shared busy boolean made Set say “Sending” during a read; the separate read/write progress state still prevents that. A successful opening read only updates the value. Pending/error occupies the existing card; Set keeps its read-back outcome. To read again, reopen Controls. Charging settings is the single remaining control in the secondary row.

The limit is a **stored** setting. Dash-command writes persist past the sender exiting, and the 80 % set at 16:56 was still in force hours later, so "unplug and it forgets" — charge-current's safety floor — is not available here. What is available, and what no other write action has, is the read-back. That is the argument for it being confirmed-and-reversible rather than behind the red fold; it is written out beside `REVERSIBLE_CONFIRMED` in `scripts/check-irreversible-actions.ts`.

Writing **0** removes the battery protection rather than moving it, so it needs its own confirm token (`confirm=charge-soc-limit-off`) and never the numeric path.

## Superseded policy before 2026-11-06

The following arguments describe the earlier stationary-only, manually read control. Daniel’s ruling above supersedes them; they are retained as design history, not current instructions.

`charge-soc-limit` and `charge-soc-limit-read` take the **bike-state gate** (`serviceActionPolicy` in `src/vcu/write-runner.ts`), unlike charge-current and charge-stop, which are exempt. The exemption exists because an automatic controller issues charge-current mid-charge and a flapping refusal would break its loop; these two are one-off human presses, where a transient refusal costs a second press. And the gate is the coverage they want: `scripts/check-service-gate-charging.ts` has it passing a stationary bike with the **drive down**, unplugged, and a stationary AC-charging one, and refusing while the bike moves — which the exemption would not. ⚠️ A stationary but ENERGIZED bike with the drive up is refused too, so "unplugged" alone overstates it.

## Former control rationale

```text
// The bike's own "stop charging at N %" setting, from the charge tab — dash command 0x2C on the
// 0x120 command channel (docs/dash-command-0x2c-charge-limit.md). Same gated /vcu-write path and
// two-tap dwell as the controls beside it, and it renders nothing unless the Pi says writes are on.
//
// ⚠️ Unlike set-current and stop, this does NOT need a live charge. The limit is a stored setting
// and the Pi gates it on the ordinary bike-state gate, which passes a parked, unplugged bike —
// which is when you are most likely to be setting it. That is why this control mounts its own
// one-shot status fetch instead of riding the charge-session edge (../lib/charge-write.js).
//
// ⚠️ It is the one write on this dashboard with a REAL read-back: the VCU answers a bit-7-clear
// read with its stored value, so "written" here means the bike holds it, not that a frame left.
// What it still does NOT mean is that the bike stops there — nobody has watched the limit be
// reached — and the note under the button says so rather than implying a guarantee.

/**
 * The READ's own key, so the two buttons cannot fire on each other's first tap.
 *
 * ⚠️ A read takes two taps as well, and that is the repo's convention rather than caution for its
 * own sake: service-mode.js's parameter sweep is read-only and has taken two taps since #130,
 * because read-only or not it puts frames on the bike's bus. A one-tap button beside a two-tap one
 * would also teach the thumb that buttons here act immediately, which is the habit the dwell exists
 * to prevent. Exported so check-arming.ts counts it as a control rather than re-typing the string.
 */
export const READ_ARMED_KEY = "charge-soc-limit-read";

```

### Former runner and liveness rationale

```text
    // ⚠️ THE GATE APPLIES, unlike the two charge commands above, and the difference is argued
    // rather than inherited. The exemption above exists because an AUTOMATIC controller issues
    // charge-current mid-charge and a flapping refusal breaks its loop; the SOC limit is a one-off
    // human press, where a transient refusal costs a second press. And the gate is exactly the
    // coverage this needs: scripts/check-service-gate-charging.ts has it passing
    // stationary-DRIVE-DOWN-unplugged and stationary-AC-charging, and refusing while the bike moves
    // — and refusing a stationary ENERGIZED bike with the drive up, which "unplugged" overstates —
    // `bikeStateGateApplies: false` would not. It is the read-service-stamp row for that reason.
  // It used to: a private read of `fast_dc_limit_max_a` at 5 s. Both actions take the bike-state
  // gate, which `checkPreconditions` runs first over seven broadcasts fresh within 1 s, fail-closed
  // — so the private one could only ever refuse something the gate had already refused, or refuse
  // FALSELY when that one signal went quiet and the gate's did not. It is gone; this is the line
  // that says why it may stay gone. Flip either policy to `false` and this goes red, which is the
  // moment a liveness check would be needed again. The per-scenario refusals live where the bytes
  // are, in scripts/check-service-gate-charging.ts §3.
```

### Former separate mount-request flag

```text
/**
 * Fetches the gate ONCE when a control mounts that is not tied to a charge session.
 *
 * ⚠️ NOT a poll, and it must not become one: at most one request per Charge-tab mount and per
 * charge ending, only when no status is held, and never while anything is ARMED — a fetch clears
 * `armed` and would disarm another control's primed button mid-gesture.
 *
 * ⚠️ It READS the derive's `statusInFlight` and never writes it, which is why it keeps a flag of
 * its own: a session ending force-clears that flag, so a mount fetch settling afterwards would
 * clear it out from under the derive's next live request.
 *
 * Why the SOC limit needs this at all, and the pacing it deliberately lacks:
 * docs/dashboard-decisions.md.
 */
```
