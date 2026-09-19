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

`0x2C` needs no answer to that question. Its replies are `2C FF <pct> 00 00 00 00 00` — b3 through b7 zero in all three archived frames and all four live replies — so it states no range at all, and the control is bounded by a declared 0–100 rather than by anything the bike says.

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

The bike answers in **1.3–7.7 ms** — inside the 4.217–10.122 ms window the dash's own exchanges occupy, and never slow. The probe that reported a "99 ms cold read" was measuring **its own send path**: it stamped 20:52:04.528Z before `channel.send`, and the kernel put the frame on the wire at 22:52:04.611064 CEST — 83 ms later, on a Pi Zero 2 W with a cold code path. The bike then answered in 5.54 ms. Measure this channel's latency from the capture, not from the sender.

## What is proven, and what is not

✅ The VCU **stores** the value. Written 90, read back 90 by two independent programs, the second 18 s later — well past the 40 ms settle, so not a pending display value.

❌ That the bike **stops** at that percentage is **not proven**, and nothing in this repo has ever observed the limit being reached: the 2026-08-02 capture ends 7 s after SOC reached its 40 % limit and the following capture is a different boot with a stepped clock. Only a charge that gets there settles it. Every message the dashboard shows says so rather than implying a guarantee.

## The signal, and its three sources

`charge_soc_limit_pct` (`src/can/registry.ts`, bounds 0–100) is an **event**, like `dc_charge_limit_selected_a` beside it — nothing rebroadcasts it, so an absent value means "not asked and not touched", never "no limit". It arrives from **three** sources, and the third is the one that has bitten this repo before (`src/charge/auto.ts`, #186):

1. the rider confirming the menu item on the bike,
2. this Pi reading it,
3. **the bike answering this Pi's own write**, ~6 ms later.

Nothing in the first version consumes it as rider intent, so the third is harmless here — but it is written down because the next reader may want to.

## Gating

`charge-soc-limit` and `charge-soc-limit-read` take the **bike-state gate** (`serviceActionPolicy` in `src/vcu/write-runner.ts`), unlike charge-current and charge-stop, which are exempt. The exemption exists because an automatic controller issues charge-current mid-charge and a flapping refusal would break its loop; these two are one-off human presses, where a transient refusal costs a second press. And the gate is the coverage they want: `scripts/check-service-gate-charging.ts` has it passing both a stationary unplugged bike and a stationary AC-charging one, and refusing while the bike moves — which the exemption would not.

The limit is a **stored** setting. Dash-command writes persist past the sender exiting, and the 80 % set at 16:56 was still in force hours later, so "unplug and it forgets" — charge-current's safety floor — is not available here. What is available, and what no other write action has, is the read-back. That is the argument for it being confirmed-and-reversible rather than behind the red fold; it is written out beside `REVERSIBLE_CONFIRMED` in `scripts/check-irreversible-actions.ts`.

Writing **0** removes the battery protection rather than moving it, so it needs its own confirm token (`confirm=charge-soc-limit-off`) and never the numeric path.
