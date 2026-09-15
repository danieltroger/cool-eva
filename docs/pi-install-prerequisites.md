# Two things a fresh Pi needs before `npm install` works

The native modules (`better-sqlite3`, `socketcan`, `spi-device`) are compiled on the Pi at install time, and on a small Pi that build has two ways to not happen: it runs out of memory, or npm declines to run it at all. This file is the research behind the two steps `INSTALL.md` §2.5 and §4 tell you to take — the version boundaries, the traps, and what was measured versus what was reported.

## Where the report came from, and what is actually established

Issue #136 is a note from **another Energica owner, relayed through a WhatsApp group** — not from this bike. Their npm version, their OS and their Pi model are all unknown and there is no way to ask. The note said: set swap to 3 GB, and run `npm approve-scripts better-sqlite3 socketcan spi-device usocket` after `git clone` and before `npm install`.

⚠️ **Treat the 3 GB and the `approve-scripts` step as one owner's working recipe, not as measurements.** What this repo has verified independently is narrower, and the split matters:

| Claim | Status |
| --- | --- |
| The four package names are exactly the ones with install scripts | ✅ verified against `package-lock.json` |
| `npm approve-scripts` cannot run before `npm install` | ✅ verified — it exits `ENOMATCH` |
| npm ≥ 12.0.0 blocks unreviewed install scripts | ✅ measured on 12.0.2 |
| npm 11.16–11.19 warn and run them anyway | ✅ measured on 11.19.0 (11.12.1 has no policy at all, so it evidences only the third band) |
| `CONF_SWAPSIZE=3072` alone yields 2048 MB on Bookworm | ✅ verified in the shipped script and man page |
| That **3 GB specifically** was needed | ❌ not verified — unknown Pi, unknown RAM |
| That their build was **blocked by npm** rather than OOM-killed | ❌ not verified, and easy to confuse — see below |

On npm 11.16–11.19 the install prints a loud warning about install scripts **and builds them anyway**. An owner who saw that warning, then hit an unrelated OOM kill, would reasonably report both fixes together. Both steps are worth taking; only one of them may have been the cause.

## 1. npm's install-script policy

npm gained an allowlist for install-time lifecycle scripts (`preinstall`, `install`, `postinstall`, and `prepare` for non-registry deps). **Which npm you have decides whether it is advice or a wall.**

| npm               | `approve-scripts` command | unreviewed install scripts        |
| ----------------- | ------------------------- | --------------------------------- |
| ≤ 11.15.0         | absent                    | **run** — no policy exists at all |
| 11.16.0 – 11.19.1 | present                   | **run**, with a warning           |
| ≥ 12.0.0          | present                   | **blocked**                       |

The boundary is npm **12.0.0**, not 11.16.0, and it is one inverted comparison in `@npmcli/arborist/lib/arborist/rebuild.js`:

- npm 11.19.0, l.208 — `isScriptAllowed(node, this.options.allowScripts) === false`. Only an explicit **deny** skips; an unreviewed package returns `null`, and `null !== false`.
- npm 12.0.2, l.215 — `isScriptAllowed(node.target, this.options.allowScripts) === true`. Only an explicit **allow** runs.

`strict-allow-scripts` is `default: false` in both (`@npmcli/config/lib/definitions/definitions.js`), so npm 11.x never hard-fails on this by default — but `--strict-allow-scripts` turns its warning into an error, which is a second way to arrive at a broken install.

⚠️ **No Node release bundles npm 12** — checked 2026-09-15, and the whole CI argument below rests on it, so re-check it rather than trusting this line. Every v24, v25 and v26 in `nodejs.org/dist/index.json` carried an 11.x that day; the highest bundled anywhere was 11.19.1, and Node 24.21.0 shipped npm 11.19.0. So a Pi that follows `INSTALL.md` §2's NodeSource step gets an npm that only warns. Reaching npm 12 takes a deliberate `npm install -g npm`.

### Did your native modules actually build? Read the phrase.

npm warns either way, and the difference is which phrase follows the count:

- `… install scripts not yet covered by allowScripts:` — they **ran**. This is advice. Nothing is broken.
- `… install scripts blocked because they are not covered by allowScripts:` — they did **not** run, and on this repo that means no `.node` files and a service that dies on `require`.

⚠️ **Read the phrase, not the tense.** The verb agrees with the count — `reify-output.js` builds it as `count === 1 ? 'package has' : 'packages have'` on npm 11 and `'package had' : 'packages had'` on npm 12 — so on this repo, which has four such packages, both versions say "packages": `4 packages have …` against `4 packages had …`. An earlier draft of this file told the reader to look for "N packages has", a string npm never prints here. `not yet covered` versus `blocked` is the half that does not move.

`npm install-scripts ls` lists what is unreviewed without changing anything — ⚠️ but only from **npm 11.18.0**, and its own output says "has/have" in every version, so the phrase test above does not apply to it.

### Why the allowlist goes in `.npmrc`, before the install

`npm approve-scripts <pkg>` matches against the **installed** tree — `arb.loadActual()`, then a scan of `arb.actualTree.inventory` (`lib/utils/allow-scripts-cmd.js`). With no `node_modules` there is nothing to match:

```
$ npm approve-scripts better-sqlite3 socketcan spi-device usocket
npm error code ENOMATCH
npm error No installed packages match: better-sqlite3, socketcan, spi-device, usocket
```

So the ordering in #136 — after `git clone`, before `npm install` — cannot work with that command. A project **`.npmrc` can**, because it is config rather than a command, and that is what this repo ships at its root:

```
allow-scripts=better-sqlite3,socketcan,spi-device,usocket
```

npm reads it as an allowScripts source (`lib/utils/resolve-allow-scripts.js`; the list is comma-split by `@npmcli/config/lib/parse-allow-scripts-list.js`), and one `npm install` then builds everything. Bare names match any version, so a dependency bump never invalidates it — the thing that makes this better than `package.json#allowScripts`, which pins. Names that match nothing in the tree are harmless, which is what makes one list correct on Linux and macOS alike.

It is the one arrangement that is correct on every npm, at the cost of one cosmetic warning on the oldest band:

| npm | without the `.npmrc` | with it |
| --- | --- | --- |
| ≤ 11.15.0 | scripts run | scripts run, **plus** `npm warn Unknown project config "allow-scripts"` on every npm command in this directory — the key does not exist before 11.16.0 |
| 11.16.0 – 11.19.1 | scripts run, warning | scripts run, no warning |
| ≥ 12.0.0 | **scripts blocked** | scripts run, no warning |

**Why committed rather than typed on each Pi** (decided 2026-09-15, having first been left out): the cost ages out and the benefit does not. That warning only exists below npm 11.16.0, so it disappears the moment a machine's Node is updated. Until then it prints on **every** machine below that line, contributors included — the bike's Pi runs npm 11.9.0 and the Mac this was written on runs 11.12.1, so both see it on every npm command in the checkout. CI does not: `node-version: 24` gets 11.19.x. The breakage it prevents is permanent until someone commits the line, and it is not only on the Pi: `.github/workflows/{test,typecheck,prettier,dashboard}.yml` all run `npm ci` on `node-version: 24`, and `test.yml` says in its own comment that this is where the native build happens.

⚠️ **`npm ci` is gated exactly like `npm install`** — it is not a way round the policy. Measured on npm 12.0.2 against a lockfile:

|                      | `bin/esbuild` after `npm ci`                                       |
| -------------------- | ------------------------------------------------------------------ |
| without the `.npmrc` | 9 294 B, `node script text` — **blocked**, `had … blocked` warning |
| with it              | 9 800 610 B, `Mach-O 64-bit executable` — built, silent            |

So the day `setup-node`'s Node 24 line carries npm 12, a repo without this file goes red in CI and ships a broken Pi at the same moment. The file is one line and nobody ever edits it locally, so it carries none of the `--ff-only` exposure that a modified `package.json` does.

### If you installed from a checkout that predates the `.npmrc`

The packages are on disk, so the command from #136 now works — though pulling the `.npmrc` is the better fix, for the reason in the second ⚠️ below:

```sh
npm approve-scripts better-sqlite3 socketcan spi-device usocket   # or: npm approve-scripts --all
npm rebuild
```

⚠️ **`npm rebuild` is not optional.** A second `npm install` reports `up to date` and runs nothing — the tree is already reified, so there is no install step left to hang the scripts off.

⚠️ `approve-scripts` writes into **`package.json`**, version-pinned: `"allowScripts": { "better-sqlite3@12.8.0": true }`. Two consequences, and together they are why pulling the `.npmrc` is the better fix. It is a tracked file, so the dashboard's Update button — `git pull --ff-only` (`PULL_ARGS`, `src/http/update.ts`) — refuses with "local changes would be overwritten" on any incoming commit that touches `package.json`, which a version-range change does. And `package.json#allowScripts` **silently supersedes the repo's `.npmrc`** from then on: precedence is CLI > `package.json` > `.npmrc`, and the lower layer gets only a `log.warn`. So a Pi that ran `approve-scripts` once is pinned to the versions it had that day, and the committed allowlist stops applying to it.

### The four packages, and why it is four and not three

From `package-lock.json`, `hasInstallScript: true` is exactly:

| package          | how it gets there                                                    |
| ---------------- | -------------------------------------------------------------------- |
| `better-sqlite3` | direct dependency                                                    |
| `socketcan`      | direct optionalDependency, Linux only                                |
| `spi-device`     | transitive, via `max31865`                                           |
| `usocket`        | transitive, via `dbus-next`'s optionalDependencies, under `node-ble` |

**Four carry install scripts; three of them are the build.** `usocket` is optional in the real sense: `dbus-next/lib/connection.js` falls back to `net.createConnection(params.path)` when `require('usocket')` throws, so a missing `usocket` costs nothing on the path this app uses. It is in the allowlist so its build does not fail noisily, not because anything needs it.

## 2. Swap

The build is memory-hungry and a Pi Zero 2 W has 512 MB. Too little swap and it is OOM-killed — which looks like a crash, not a memory problem.

Raspberry Pi OS **Bookworm** installs `dphys-swapfile`; **Trixie** installs `rpi-swap`, which declares `Provides/Conflicts/Replaces: dphys-swapfile` (pi-gen's `bookworm` branch lists the former in `stage2/01-sys-tweaks/00-packages`, `master` lists the latter).

### Bookworm — and the trap that silently halves your swap

⚠️ **`CONF_SWAPSIZE=3072` on its own gives you 2048 MB.** `CONF_MAXSWAP` defaults to 2048 and clamps the absolute value, not just the computed one. `dphys-swapfile(8)`, verbatim:

> **CONF_MAXSWAP** Set size restriction of maximal computed and absolute(!) values, in MBytes. Defaults to 2048…

and the shipped script (`dphys-swapfile 20100506-7.1+rpt3`, the newest in `archive.raspberrypi.com`) does exactly that, after the block that would compute a size:

```sh
if [ "${CONF_MAXSWAP}" != "" ] ; then
  if [ "${CONF_SWAPSIZE}" -gt "${CONF_MAXSWAP}" ] ; then
    echo -n ", restricting to config limit: ${CONF_MAXSWAP}MBytes"
    CONF_SWAPSIZE="${CONF_MAXSWAP}"
```

So **both** variables have to be set. The image ships `CONF_SWAPSIZE=512` — patched in by pi-gen's `bookworm` branch (`stage2/01-sys-tweaks/00-patches/02-swap.diff`); the package's own `/etc/dphys-swapfile` has every value commented out.

`dphys-swapfile setup` calls `swapoff` itself before resizing, so the leading `swapoff` in the usual recipe is belt-and-braces rather than required.

### Trixie — `rpi-swap`, where the clamp works the other way

⚠️ Line numbers below are for **rpi-swap 1.2.1**, the version on the bike. They move between releases: the config mapping is at l.309-310 in 1.2.1 and l.355-356 in 1.2.4. Check your version with `dpkg -l rpi-swap`.

The recipe is `swap.conf(5)`'s own Example 1 with the size changed, and the man page is emphatic that a **reboot** is required (`daemon-reload` regenerates units but will not restart swap).

✅ Here `MaxSizeMiB` does **not** clamp `FixedSizeMiB` — the opposite of Bookworm. `rpi-desired-swap-size` guards its whole computation on `CONF_SWAPSIZE` being unset or non-numeric, so a valid integer skips both clamps and is echoed unchanged; the generator maps `File::FixedSizeMiB` → `CONF_SWAPSIZE` and `File::MaxSizeMiB` → `CONF_MAXSWAP` (l.309-310, 1.2.1). `swap.conf(5)` agrees independently: `FixedSizeMiB` _"overrides the RamMultiplier calculation and is used directly"_.

### ⚠️ What the bike's Pi is in, and why the recipe above does not apply to it as written

Measured by read-only probe, 2026-09-15: Trixie, `rpi-swap 1.2.1`, `/etc/rpi/swap.conf` entirely at defaults, **`rpi-resize-swap-file.service` masked**, and 2048 MiB of swap active from a hand-written `/etc/fstab` line (`/var/swap none swap sw,pri=10 0 0`). `rpi-swap`'s own `dev-zram0.swap` is loaded but inactive with `disksize 0`.

The drop-in recipe does not apply here for two reasons, in this order:

1. **Its generated `.swap` unit carries `Requires=rpi-resize-swap-file.service`**, which is masked — so the unit cannot start. This is the proximate cause, and it still bites after the fstab line is removed.
2. **Following the recipe would make the two generators collide over one unit filename** — which, ⚠️ note, they do **not** today. Under `zram+file` `rpi-swap-generator` calls `create_swap_unit "/dev/zram0" …` (l.272, 1.2.1) and so writes `dev-zram0.swap`; only the `swapfile` branch (l.403) writes `$(systemd-escape --path --suffix=swap /var/swap)` = `var-swap.swap`. That is why the bike shows `dev-zram0.swap` **and** `var-swap.swap` side by side with no contest: the second is systemd's own `fstab-generator`, which builds the same name from `unit_name_from_path(what, ".swap")` into the same `arg_dest = argv[1]`. Set `Mechanism=swapfile` here — which is exactly what §2.5's recipe says — and both would write it.

   ⚠️ Not "one silently overwrites the other", which an earlier draft of this file claimed. systemd opens generated units `O_EXCL` (`fopen_unlocked(p, "wxe", …)` in `generator_open_unit_file_full`) and on collision logs `Failed to create unit file … as it already exists. Duplicate entry in …?`; `rpi-swap-generator` truncates unconditionally (`cat <<EOF > "${unit_path}"`). Generators run in parallel, so it is a race: rpi-swap second and fstab's unit is replaced silently; fstab second and it logs an error and drops the entry. Either way `systemctl cat var-swap.swap` names the winner — on the bike, `systemd-fstab-generator`, corroborated by the `pri 10` in `/proc/swaps` against the `Priority=100` `create_swap_unit` hardcodes (l.91).

   ⚠️ The systemd line numbers are deliberately omitted: they move every release (l.254/258/1758 on `main` today, 244/248/1687 on the 257 that Trixie ships), and unlike the rpi-swap ones there is no single version a reader here can be assumed to have.

Two safe ways out, both reasoned from the package source and **not executed on the bike**:

- **Go supported:** put the drop-in in place **first**, then `systemctl unmask rpi-resize-swap-file.service`, remove the `/var/swap` line from `/etc/fstab`, and reboot. ⚠️ The ordering matters: `rpi-resize-swap-file` resizes `/var/swap` to whatever the config says, and with no `FixedSizeMiB` that is `RamMultiplier` (default 1) × RAM — a few hundred MB on a Zero 2 W. Unmask before the drop-in exists and it shrinks the file rather than growing it (`truncate --size` at l.47, then `swaplabel || mkswap` at l.61-62, 1.2.1).
- **Keep the fstab file:** point `rpi-swap`'s `File::Path=` at a different path so the two stop contending for `/var/swap`.

🚨 **Not `Mechanism=none`, and not `Mechanism=zram`.** `swap.conf(5)` states the outcome plainly — of `none`: _"No swap is configured. Any existing swap file will be removed to free up disk space."_, and of the `[File]` options: _"These options are disregarded for mechanisms that don't involve a file (e.g. "zram"), and any existing file will be removed."_ The mechanism is `rpi-remove-swap-file@.service`, whose entire body is `Conflicts=%i.swap` and `ExecStart=/bin/rm -f /%I`, symlinked into `local-fs.target.wants` (l.56-57, 1.2.1). Documented, not discovered — but it reads like a tidy-up setting and it is not, so it is repeated wherever the config is discussed.

### What happens on a card without room for it — and the two OSes differ

⚠️ **Bookworm clamps; Trixie fails.** This asymmetry matches the `CONF_MAXSWAP` one above and has the same cause: an absolute size is handled differently from a computed one.

- **Bookworm** clamps and tells you. `CONF_MAXDISK_PCT` (default 50) is applied to `CONF_SWAPSIZE` whether it was computed or given, and `sbin/dphys-swapfile` prints `restricting to 50% of remaining disk size: …MBytes` when it bites. You get a smaller swap file than you asked for, and a line saying so.
- **Trixie does not clamp `FixedSizeMiB` at all.** `MaxDiskPercent` and `MaxSizeMiB` both live inside `rpi-desired-swap-size`'s `if [ -z "${CONF_SWAPSIZE}" ] || ! [ … -eq … ]` guard (l.38, 1.2.1), which a valid integer skips entirely. So `rpi-resize-swap-file` runs `fallocate --posix --length 3072M`, that fails for want of space, and `set -e` (l.3) aborts the service. The generated `var-swap.swap` carries `Requires=rpi-resize-swap-file.service`, so **the Pi boots with no swap at all** — worse than before the change, and the OOM kill that §2.5 exists to prevent happens anyway. `df -h /var` before, `swapon --show` after.

## 3. Joining a second Wi-Fi network without leaving the one you are on

`nmcli device wifi connect` — nmcli(1), verbatim: _"finds a matching connection or creates one and then activates it on a device"_ — is right for the first join and wrong over ssh, because activating the new network drops the session you are typing into. It also notes that _"only open, WEP and WPA-PSK networks are supported if no previous connection exists"_.

`nmcli connection add` only _"Create[s] a new connection using specified properties"_ — no activation — which is what you want when you are on the phone's hotspot and adding, say, an Airbnb's network for later:

```sh
sudo nmcli connection add type wifi ifname wlan0 con-name "<ssid>" ssid "<ssid>" \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "<pw>" connection.autoconnect no
sudo nmcli connection modify "<ssid>" connection.autoconnect yes   # once you are done on this link
```

Adding with `connection.autoconnect no` and flipping it afterwards makes "it will not switch under me" a configured fact rather than a hope. Daniel reports (bike, 2026-09-15) that adding with `autoconnect yes` directly did not switch either — ⚠️ that is a field observation, not documented nmcli behaviour: the man page says what `add` creates and nothing about what NetworkManager does with an already-active connection afterwards.

**The Pi Zero 2 W radio is 2.4 GHz only** — raspberrypi.com gives it as _"2.4GHz 802.11 b/g/n wireless LAN"_ — so it cannot see a 5 GHz-only hotspot at all. That is what Apple's **Maximize Compatibility** toggle is for, and Apple scopes it to exactly the devices that broadcast 5 GHz: _"If you're using an iPhone 12 model or later, iPad Pro 11-inch (3rd generation or later), iPad Pro 12.9-inch (5th generation or later), or iPad mini (6th generation)"_ → _"Tap Personal Hotspot and turn on Maximize Compatibility."_ ⚠️ It is not free, in Apple's own footnote: _"When you turn on Maximize Compatibility, internet performance and Wi-Fi security might be reduced for devices connected to the hotspot."_

`wifi-sec.key-mgmt wpa-psk` above is WPA2-PSK, so a WPA3-only network needs `sae` instead.
