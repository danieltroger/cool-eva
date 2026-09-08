# If the charge-current feature does not act — a brief for a session started on the Pi

For a Claude Code session started **on the bike's Pi, from a phone, at a charger**, when the automatic charge-current control or the Set-charge-current button appears to do nothing. One screen of orientation, then commands to paste.

`ssh pi@cool-eva.local`, checkout at `/home/pi/cool-eva`, service `cool-eva`.

## Rails — read these first, they are not advice

- **Do not inject anything onto the CAN bus outside the app's own path.** The one experiment below goes through the dashboard, with all its gates. Nothing else.
- **Do not restart the service mid-charge.** It re-initialises `can0`, which kills any other raw socket with `OSError 100`.
- **Never capture to `/tmp`** — it is tmpfs, and the Pi loses power with the bike.
- **Do not `npm install`** unless a dependency actually changed. The rest of that trap, and every other deploy hazard, is in `CLAUDE.md` § "Deploying to the Pi (learned the hard way)" — read it there rather than trusting a copy here, because a copy drifts and the copy is the one a phone reads.

## What should have happened

During a DC charge, the Pi commands a reduced current and the charge tab shows a verdict within ~10 s of each command. A command from the Set-charge-current button does the same.

## The one fact that explains the last failure

On 2026-09-07 this feature changed the number on the bike's dash and moved no current at all — for five days, because the Pi was running a build from **before** the `0x120` commit twin landed. It was sending half the sequence. Nothing on the bike could say which commit it was running, so it looked like a broken feature instead of an old one.

**So check the version first.** It is now in three places:

```bash
journalctl -u cool-eva -b | grep 'cool-eva: running'      # the startup banner
curl -s localhost/vcu-write | head -c 200                 # runningVersion in the payload
cd /home/pi/cool-eva && git log -1 --oneline && git status -sb
```

If `git status` says the branch is behind, or the banner says `+dirty`, **that is the answer** — nothing else needs investigating.

## The three signals, and the trap

| signal | what it is | use it for |
| --- | --- | --- |
| `fast_dc_target_a` | 0x615 b2 — the vehicle's own request to the station | **the acknowledgement.** It moves whether or not the station can follow |
| `pack_a` | what actually flowed | context only — it conflates "the VCU took my command" with "the station could deliver it" |
| `charge_limit_a` | 0x10A b7 ÷ 7 — the **AC** setpoint | ⚠️ **not for DC.** It reads a flat 0.0 through every DC session |

⚠️ **Dialling DOWN lands exactly; dialling UP is station-bound.** An increase that does not move the current is the charger's decision, not a fault. Only a reduction proves a command took.

## Commands

```bash
# What the service thinks it did, newest last
journalctl -u cool-eva -f | grep -iE 'charge-ack|charge current|vcu-write'

# Every attempt to change the bike, ever — including the verdict and the running commit
tail -5 /home/pi/cool-eva/vcu-params/service-writes.jsonl

# The live signals, without a database (there is no rides.db on the Pi)
curl -s localhost/status | head -c 400
```

**Is the pair actually going out?** This is the check that would have caught 2026-09-07 directly. Run it in one window, send a command from the phone in another:

```bash
candump -td can0,120:7FF,121:7FF
```

Two frames per command — `120 98FF<amps>...` then `121 18FF<amps>014B...`, a few ms apart. **One frame is the 2026-09-07 bug.** Zero frames means the command never reached the bus, so look at the refusal in the journal instead.

## The one safe experiment

**Dial DOWN from the dashboard's own Set-charge-current control** — never up, because an unobeyed increase proves nothing. Pick a value clearly below what is flowing, send it, and watch:

```bash
candump -td can0,615:7FF        # fast_dc_target_a is byte 2
```

The request should stop exceeding the value you asked for, within a second. The charge tab will say the same thing in words. This is the app's own path with all of its gates — not an injection.

## What to write down

Put findings in the repo, not in the session: `docs/can-0x121-charge-command.md` for anything about the frames, and a GitHub issue for anything else. A phone session's conclusions evaporate otherwise, and this exact ground has been re-derived once already.
