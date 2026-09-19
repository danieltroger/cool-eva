# Wifi on the Pi: why it stopped trying on 2026-09-19, and what now records it

The Pi joins the owner's iPhone hotspot and, at home, a house network. It carries no screen and no second radio, so **the only way to ask it anything is over the very wifi that is failing.** That is the whole shape of the problem this document is about.

⚠️ **Every SSID and BSSID in this document is redacted or synthetic, and that is a rule rather than tidiness.** A BSSID is a _coordinate by another name_: wifi-positioning databases key a street address off an access point's MAC, so publishing the one on the wall geolocates the house as surely as a latitude would. `docs/route-map.md` forbids coordinates in committed files; this is the same rule wearing a disguise. The real values live in the dumps on the Pi, which is why `wifi-diag/` is in `.gitignore`. Placeholders here are `‹hotspot›` / `‹home-wifi›` for names and locally-administered `02:…` addresses for BSSIDs, which can never collide with a real AP.

## 1. The 2026-09-19 failure — NetworkManager latched the profile out of autoconnect

**The Pi did not fail to join. It stopped asking.**

Boot `a984e8091e1145739e006ed17e86f15d`, 10:43:29 → 11:09:00 CEST, with a DC charge running inside it (`charge-auto` commanded 79 A at 11:01:46).

| when (CEST) | journal |
| --- | --- |
| `10:43:44.011` | `Associated with ‹bssid-A›`, DHCP `172.20.10.4`, `Activation: successful` |
| `10:47:03.632` | `CTRL-EVENT-DISCONNECTED bssid=‹bssid-A› reason=0 locally_generated=1` |
| `10:47:19.276` | `link timed out` → `activated -> failed (reason 'ssid-not-found')` |
| `10:47:36`–`10:48:50` | six association attempts, all at the same **stale** BSSID `‹bssid-A›`, all answered `CTRL-EVENT-ASSOC-REJECT bssid=00:00:00:00:00:00 status_code=16`, with `CTRL-EVENT-SSID-TEMP-DISABLED … auth_failures=1,2 … reason=CONN_FAILED` |
| `10:48:02.196`, `10:48:27.196` | `Activation: (wifi) asking for new secrets` |
| **`10:48:52.193`** | **`config -> failed (reason 'no-secrets')`** |
| `10:49:00.731` | `supplicant interface state: disconnected -> inactive` |
| → `11:09:00.754` | **nothing. 20 min 00 s, not one further NetworkManager or wpa_supplicant line.** |

The next boot associated **14 seconds** after `wpa_supplicant` started.

### The mechanism, from NetworkManager 1.52.1's own source

The Pi runs exactly 1.52.1 (`NetworkManager --version`), so these are quoted from that tag rather than from a nearby one.

`src/core/nm-policy.c`, `_device_state_changed()` — a FAILED transition whose reason is `NO_SECRETS`:

```c
case NM_DEVICE_STATE_REASON_NO_SECRETS:
    con_v = nm_settings_connection_get_last_secret_agent_version_id(sett_conn);
    if (con_v == 0 || con_v == nm_agent_manager_get_agent_version_id(priv->agent_mgr)) {
        _LOGD(LOGD_DEVICE, "block-autoconnect: connection '%s' now blocked from autoconnect due to no secrets", ...);
        nm_settings_connection_autoconnect_blocked_reason_set(
            sett_conn, NM_SETTINGS_AUTOCONNECT_BLOCKED_REASON_NO_SECRETS, TRUE);
        blocked = TRUE;
    }
    break;
```

`blocked = TRUE` also skips the `if (!blocked)` retry-countdown arm below it, so the profile does not even spend a retry.

`src/core/settings/nm-settings-connection.c`:

```c
    if (priv->autoconnect_blocked_reason != NM_SETTINGS_AUTOCONNECT_BLOCKED_REASON_NONE)
        return TRUE;
```

and `src/core/nm-policy.c`, `_auto_activate_device()` — the `continue`, and the log line it skips:

```c
        if (nm_manager_devcon_autoconnect_is_blocked(priv->manager, device, candidate))
            continue;
        ...
    _LOGI(LOGD_DEVICE, "auto-activating connection '%s' (%s)", ...);
```

That `_LOGI` is the journal's `policy: auto-activating connection 'Wi-Fi connection 2' (45eacfc9-…)`. **Its absence is the finding.**

⚠️ **Nothing clears the latch on a timer**, which is the property that matters — but this enumeration is the corrected one, because an earlier draft said "the only paths" and named two of three:

1. an update carrying **new secrets** (`nm-settings-connection.c`, _"New secrets, allow autoconnection again"_);
2. `reset_autoconnect_all(…, only_no_secrets = TRUE)` from `secret_agent_registered()`;
3. `reset_autoconnect_all(…, only_no_secrets = FALSE)` from `sleeping_changed()` (`nm-policy.c`), which fires on `notify::networking-enabled` — **so `nmcli networking off && nmcli networking on` is a third cure**, and a blunter one than a reboot.

None is time-based, so the latch lives as long as the `NetworkManager` process unless somebody does one of them.

### In order

1. iOS took the hotspot's radio down — `locally_generated=1` is our side observing the beacons stop.
2. wpa_supplicant kept re-associating to the BSSID it remembered. **The iPhone randomises its hotspot MAC on every restart**: the profile has accumulated **30** `seen-bssids`, and nine distinct ones were associated with on 2026-09-19 alone. Status code 16 with `bssid=00:00:00:00:00:00` is the local join timing out, not an AP refusing us.
3. NetworkManager read repeated association failure as a wrong PSK and asked for new secrets. **On a headless Pi the PSK is in the keyfile and no secret agent is registered**, so `con_v == 0` and the branch above always blocks.
4. The profile was out of autoconnect for the life of the process.
5. **Rebooting the iPhone could not help** — the latch is on the _profile_, and a new AP does not touch it. Only the bike off/on did, because that is a fresh `NetworkManager`.

### The natural experiment that settles it

Every activation failure logged on 2026-09-19, and whether NetworkManager retried:

| failed           | reason                  | next `auto-activating`              |
| ---------------- | ----------------------- | ----------------------------------- |
| 10:47:19.284     | `ssid-not-found`        | 17.5 s                              |
| **10:48:52.196** | **`no-secrets`**        | **never — 20 min of boot remained** |
| 11:53:26.175     | `ssid-not-found`        | 6 min 53 s                          |
| 13:16:06.146     | `supplicant-timeout`    | 0.6 s                               |
| 13:16:57.067     | `ssid-not-found`        | 6 min 54 s                          |
| 13:45:35.148     | `ssid-not-found`        | 14 min 58 s                         |
| 14:07:16.172     | `ssid-not-found`        | 41.5 s                              |
| 14:09:47.145     | `ssid-not-found`        | 2 min 14 s                          |
| 16:44–16:58 (×5) | `ip-config-unavailable` | retried                             |

⚠️ **The table is the thirteen failures in the captured window; a later pull reaches fifteen day-wide** (7 `ssid-not-found`, 5 `ip-config-unavailable`, 2 `supplicant-timeout`, 1 `no-secrets`). Of the fifteen, **twelve were retried, two are inconclusive** — their boot ended at or near the failure, so nothing can be concluded either way — **and one was never retried.**

**That one is the only one whose reason was `no-secrets`** — and `grep -c "no-secrets"` over the _entire_ retained journal, which begins 2026-09-15 04:12:34 and covers roughly forty boots, returns **1**. One occurrence in four and a half days, and it is the one silence.

### Ruled out, each with its evidence

| hypothesis | verdict |
| --- | --- |
| 5 GHz hotspot vs a 2.4-only radio | **No.** All 125 hotspot association attempts in the window are `freq=2437 MHz` (ch 6); the house network is 2472. `nmcli device show wlan0` → `5GHZ: no`, `2GHZ: yes`. Both networks are 2.4 GHz |
| rfkill | **No.** `phy0: Wireless LAN — Soft blocked: no, Hard blocked: no` |
| a BSSID pinned in the profile | **No.** `802-11-wireless.bssid: --`. The 30 `seen-bssids` are a history, not a lock |
| regulatory domain | **No.** `cfg80211.ieee80211_regdom=SE` on the kernel command line, `country DE` from the AP's country IE. Channel 6 is legal in both |
| the iPhone | **No.** The next boot joined in 14 s with the phone untouched |
| a driver wedge | **Not needed.** `Failed to initiate sched scan` appears in every failure window on this brcmfmac build (BCM43430/2, firmware `9.88.4.77`, 2022) and deserves its own issue, but the policy code above is what kept NM quiet |

### ⚠️ What this evidence cannot say

- **Whether the hotspot was beaconing during 10:49–11:09.** NM logged no scans at `<info>`, so no scan result exists for the window. It does not matter to the diagnosis: a blocked profile is not consulted whatever is in range.
- **The `block-autoconnect: …` line is `_LOGD`** and this Pi runs NM at the default level, so the latch is inferred from the absence of the `_LOGI` plus the source path above — not read directly. The inference is tight (that `continue` is the only thing between a visible candidate and that line) but it is an inference.
- **Which charge Daniel meant by "the second".** `charge-auto` commanded DC current in three episodes that day — 11:01–11:08, 11:54–12:03, 13:19–13:23 — and the failure sits inside the first. The Pi reboots at key-off, so charges and boots do not line up one-to-one.

## 2. What is recorded now

`src/wifi/status.ts` polls `nmcli` and publishes three signals. They are log-on-change, so a healthy boot writes a handful of rows and then nothing.

| signal              | meaning                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `wifi_link_state`   | `0` unavailable · `1` disconnected · `2` connecting · `3` connected |
| `wifi_network`      | `0` none · `1` the hotspot · `2` some other network                 |
| `wifi_hotspot_seen` | the hotspot's SSID is in NetworkManager's scan list                 |

⚠️ **There is deliberately no `wifi_signal_pct`.** A percent has no honest value while the radio is disconnected, and an unwritten signal goes stale — so it would drag this group's `/status` liveness fraction down during exactly the fault the group exists for. The real strength, in dBm rather than nmcli's percent, is in the dump's `iw dev wlan0 link`. All three signals above are written on **every** successful poll, so the group is either fully live or genuinely unknown, never permanently part-dark.

⚠️ **Nothing is recorded when the read itself fails.** Writing `wifi_hotspot_seen = 0` because `nmcli` did not answer would assert "the hotspot is not in range" — the opposite of what a failed read means, and the one claim this whole diagnosis turns on.

⚠️ **`WIFI_HOTSPOT_SSID` has no default and must be set on the Pi.** It names the network `wifi_hotspot_seen` and `wifi_network` are measured against, and it is left out of the code because a public repo is no place for somebody's network name. Put it in `/etc/default/cool-eva` and restart:

```bash
echo 'WIFI_HOTSPOT_SSID=your-hotspot-name' | sudo tee -a /etc/default/cool-eva
sudo systemctl restart cool-eva
```

⚠️ **Unset, the hotspot half is OFF and says so** — one `console.warn` at startup naming the variable and the file, `wifi_link_state` still recorded, the second `nmcli` call skipped, and no fault dump ever written. That is deliberate: a feature whose whole purpose is catching something that quietly stopped trying must not itself quietly stop trying.

⚠️ **`wifi_hotspot_seen` is the one that answers this failure**, and only together with `wifi_link_state`: _"the hotspot is in range **and** we are not on it"_ is the shape of the fault, and neither half says it alone. The journal gets the same sentence, once, when it changes: `wifi: NOT connected, and the hotspot IS in range`.

It is readable during the silence, which is not obvious — a blocked profile might have meant no scanning either. It does not: `nm-device-wifi.c`'s `_scan_notify_allowed()` sets `periodic_allowed = TRUE` for `DISCONNECTED` and `FAILED` (_"Can always scan when disconnected"_), rescheduled 3 → +20 → 120 s and independent of any autoconnect block. ⚠️ **That citation came from a reviewer and has not been opened by the author of this document**; it is the one claim here not read at first hand, and it wants confirming before anything is built on it.

### ⚠️ Their own `wifi` group, and the trap that forced it

`public/lib/bounds-rules.js` has `BOOLEAN_GROUPS = new Set(["controls", "diag", "buttons"])`. A code signal in `diag` with a blank unit is therefore gated to `[0, 1]` — so `wifi_link_state = 3` on a perfectly connected bike would be **drawn as a dead sensor**. Declaring `bounds` avoids it, but in a group with no fallback rule `scripts/generate-signal-bounds.ts` goes further and _refuses_ a key that declares neither `bounds` nor `unbounded`: the group fails closed, and a future `wifi_*` cannot arrive ungated. `scripts/check-wifi-diag.ts` resolves each key's bound **from its registry entry** rather than spelling the group, so moving them back into `diag` turns it red.

### ⚠️ The poll is 8 s because `/status` says so

`src/http/status.ts` counts a signal live only if it arrived within `FRESH_MS` = 10 s, and `live === 0` is what a reader of that summary filters on to find a dead source. **A `source: "poll"` signal polled slower than that window reads as dark on a healthy Pi.** `can_link` already does this at 15 s and gets away with it only because it sits in a `diag` group of three dozen other signals that dilute the fraction; a three-signal group has nothing to hide behind. So the poll is faster than the window rather than an exception to it, and `FRESH_MS` is exported so the check can pin the two together.

⚠️ **The per-call timeout is part of that same contract, which is not obvious.** Two `nmcli` calls run per cycle, sequentially — so a cycle can last twice the per-call ceiling, and if that exceeds the poll interval the re-entrancy guard skips a tick. Two skipped ticks compound into a gap past `FRESH_MS`. At the 5 s ceiling this shipped with, the worst gap was **16 s against a 10 s window**: the module would have defeated its own contract by a path no check could see. It is 3 s, `2 × 3 < 8` is asserted, and a cycle that genuinely times out is _allowed_ to read dark — then we cannot say, and saying so is right.

⚠️ **The dump is never awaited by the poll either**, for the same reason one level up: a dump runs a dozen children and can take a minute, and held inside the poll's in-flight flag it would skip poll after poll during exactly the fault it is dumping.

Measured on this Pi Zero 2 W (quad-core): ten sequential cycles of the two `nmcli` calls cost 1.289 s user + 0.560 s sys, i.e. **~185 ms of CPU per cycle — 2.3 % of one core, ~0.6 % of the machine**, or about 33 minutes of CPU and 21 600 `nmcli` executions a day. Almost all of it is fork+exec: `nmcli` links libnm, glib and D-Bus, so the two calls cost about the same and dropping either would halve the feature. ⚠️ That is a **floor**: a `/proc/stat` delta over the same run showed 3.72 CPU-seconds, which includes NetworkManager's own D-Bus work and the service's 100 Hz baseline and was not separated out.

## 3. The dump

**When it is taken:** automatically, once the Pi has been **disconnected with the hotspot in the scan list for two minutes**, and then no more than once every fifteen. ⚠️ Two minutes is far past any roam — NetworkManager retried after twelve of the failures above, the quickest in 0.6 s — and deliberately _below_ the longest ordinary retry (14 min 58 s), because those long gaps are the same fault class and each is worth a dump. The handlebar button will take one on demand too, once §4's question is answered.

`src/wifi/dump.ts` writes the whole picture — `nmcli` device and connection state, the scan list, `iw link` / `scan dump` / `reg get`, `rfkill`, addresses and routes, and **the last 20 minutes of NetworkManager and wpa_supplicant** — to `/home/pi/cool-eva/wifi-diag/<timestamp>.txt`.

- ⚠️ **Not `/tmp`, and not a plain `writeFile`.** `/tmp` is tmpfs here and the bike cuts 12 V at key-off, so a dump taken at a charger would be gone before anyone could read it. The same cut is why the write goes through `replaceFileDurably`: ext4's `delalloc` leaves up to 30 s in which `i_size` says the bytes are there and the blocks read NUL (`docs/power-cuts.md`), so a plain write would have made the one failure this location was chosen to survive the one its write path does not. The rename leaves a `<name>.txt.tmp` if a cut lands between write and rename, and the prune reaps those first — they do not end in `.txt`, so nothing else ever would.
- ⚠️ **`wifi-diag/` is in `.gitignore`.** A dump carries SSIDs and BSSIDs — the networks this bike and its owner have been near — which is the same class of thing as the coordinate rule in `docs/route-map.md`, in a form that looks innocuous.
- ⚠️ **A profile is addressed by NAME, never by SSID.** NetworkManager 1.52.1's `nmc_find_connection()` matches uuid, id, path and filename and has no SSID arm — and on this Pi the hotspot's profile is called **`Wi-Fi connection 2`** while its SSID is something else entirely. So asking for the profile by SSID can only ever answer "unknown connection", and the per-profile detail carrying `autoconnect-priority`, `seen-bssids` and any pinned `bssid` — which is where the 2026-09-19 answer lives — would have been missing from every dump. The names are looked up first, with one extra read whose own result stays in the dump.
- **Every collected command is a read.** No `connection up`, no `device disconnect`, no forced rescan (`--rescan no` on the list, `scan dump` rather than `scan`, because a forced scan costs airtime and can disturb an association). A dump must be safe to take mid-charge on a healthy link.
- **Secrets**: `nmcli connection show` prints the PSK as `<hidden>` unless `--show-secrets` is passed, and it is never passed — that is the control that matters. `buildWifiDump()` redacts secret-looking settings as a second line of defence, and the check feeds it a fixture _carrying_ a real-looking PSK, because a redaction test whose input has nothing to redact passes with the redactor deleted.
- **Failures are reported, never dropped**: a non-zero exit, its stderr, a timeout and a truncation all reach the file. ⚠️ Node's `execFile` default buffer is 1 MB and it **kills** the child on overflow, so the command that overflows is the one whose output is lost — and the likeliest to overflow is the journal, whose size grows with exactly the trouble worth capturing. The buffer is 8 MB, the journal call is bounded by `--lines` as well as `--since`, and a truncated capture says `TRUNCATED` rather than looking complete.

## 4. What is not built yet

- **The handlebar gesture** — a long hold that takes a dump and forces a rejoin. Designed and reviewed on #290; **blocked on which physical button "speedo-set" names.** A 5 s hold cannot go on `btn_cruise_set`: it has 26 presses at or over 5 s across the two archives, and 16 of the 21 in the ride log were made at ≤ 2.5 km/h, so a stationary gate does not separate them either. `docs/handlebar-gestures.md` has the table.
- ⚠️ **A rejoin will rescue the link but will not cure the latch.** `nmcli connection up` is an explicit `ActivateConnection`, and `autoconnect_is_blocked` is consulted only on the autoconnect path — so it works while blocked, but the block survives it. After one `no-secrets` event, every later drop in that boot needs another hold. The cure is a secret agent, or an unattended watchdog; both are follow-ups.
- **A watchdog** that rejoins on its own after N minutes of "disconnected with the hotspot in range". Deliberately not in the first change: the ask was diagnosis, logging and a button.

## 5. Reading it back

```
ssh pi@cool-eva.local 'ls -t /home/pi/cool-eva/wifi-diag | head'
```

⚠️ **`journalctl -b <offset>` offsets re-number on every boot**, and this Pi reboots whenever the bike's 12 V drops. An offset captured at the start of an investigation points at a different boot twenty minutes later — it happened twice while this document's evidence was being pulled. Take the 32-hex **boot ID** from `journalctl --list-boots` and use `journalctl -b <id>`; NetworkManager's own startup line prints `(boot:<uuid>)` and cross-checks it.

⚠️ **`iw` and `rfkill` live in `/usr/sbin`, which is not on a non-login shell's PATH.** `ssh pi@cool-eva.local 'iw dev wlan0 link'` answers `command not found`; the absolute path works. `src/wifi/nmcli.ts` spells every binary absolutely for this reason.
