# Updates for bundles and existing checkouts

Bundle installs use **Menu → Settings → Cool Eva → Update**. Park and keep the Pi powered with internet access. Update downloads the same prebuilt runtime/dependencies used by setup, verifies them, then reserves a safe stop. If moving, busy or settings changed, it leaves the app running and explains what to do. A failed candidate switches back automatically; ride data stays outside releases. No Git/npm/native build runs on a rider's Pi. [Bundle rollback, power-loss and slow-crash limits](bundle-updater.md).

Existing checkout installs continue using their owner-run Git updater until deliberately migrated. [New setup](manual-install.md) and [migration acceptance](bundle-installation.md#daniels-first-real-migration--go-at-the-bike) are separate from the checkout findings below.

The rest of this document preserves the checkout updater's ownership reasoning and historical measurements. Its operator commands live in [checkout installation](checkout-install.md#3-get-the-code).

## The rule

**The pull runs as the checkout's owner. Never as root, even though the service is root.**

`asOwnerCommand()` builds `sudo -n -u '#<uid>' -H git -C <dir> pull --ff-only`, with the uid read from the checkout itself (`pullCommandFor()`). `scripts/setup-service.ts` verifies the remote through the same function at install time, so what the installer proves is what the button will do.

## What went wrong, 2026-09-08

The button had failed with `Host key verification failed. fatal: Could not read from remote repository.` — the service runs as root, and `update.ts` tried to borrow `pi`'s ssh credentials by setting `HOME=/home/pi` on the git call.

That override never worked, and the reason is the one fact worth carrying out of this whole episode: **OpenSSH expands `~` from the effective uid's passwd entry, not from `$HOME`.** Measured, and reproducible on any machine:

```sh
HOME=/nonexistent ssh -G github.com | grep userknownhostsfile
# still prints your real ~/.ssh/known_hosts
```

So root's ssh read `/root/.ssh` whatever `HOME` said. The symptom is confusing in a specific way: the button fails while `git pull` by hand as `pi` works fine.

While proving a fix, the button's exact command was run **as root** on the Pi. It succeeded — and left root-owned files behind under `.git` (`logs/refs/remotes/origin/*` among them). The next pull as `pi` then died:

```
error: cannot update the ref 'refs/remotes/origin/deploy-path': unable to append to
'.git/logs/refs/remotes/origin/deploy-path': Permission denied
```

**That is the failure worth remembering, because of its shape rather than its cause.** The fast-forward does not happen, the exit is non-zero but nothing on the bike reads it, the service restarts, and the journal looks entirely healthy — while the Pi runs the old commit. A deploy that silently does nothing is worse than one that fails loudly, and this one was invisible from the phone.

Repair, if a Pi is in this state:

```sh
sudo chown -R pi:pi /home/pi/cool-eva
```

`scripts/setup-service.ts` checks for it at install (`warnIfGitIsWronglyOwned`), and `deployHint()` names the repair if the button hits it.

⚠️ Two failures look almost identical in git's output and want opposite advice. `Unable to create '…/.git/ORIG_HEAD.lock': **Permission denied**` is this ownership bug. `Unable to create '…/.git/index.lock': **File exists**` is a stale lock — a bike switched off mid-pull — where nothing is wrong with ownership and the fix is to delete the file. So the ownership arm requires `Permission denied` on the same line rather than matching the `Unable to create` prefix, which would give a `chown` instruction for a dead battery.

### ⚠️ Which paths actually go root-owned

Not the obvious ones. **A pull neither creates nor rewrites `.git` or `.git/logs/refs`**, so both keep the ownership the _clone_ gave them however the pull ran — sampling them finds a poisoned checkout perfectly innocent. This is not theory; the first version of the installer check did exactly that and could not have fired on the incident it was written for. Verified by inode:

```
after clone:  143410603  .git
              143410656  .git/logs/refs
              MISSING    .git/logs/refs/remotes/origin/main
after pull:   143410603  .git                                  ← unchanged
              143410656  .git/logs/refs                        ← unchanged
              143410686  .git/logs/refs/remotes/origin/main    ← created by the pull
```

What a root pull leaves root-owned is the **leaves it creates**: `logs/refs/remotes/origin/<branch>`, `FETCH_HEAD`, per-ref files under `refs/`. That is precisely the path the Pi's error named. So `findForeignOwnedPaths()` recurses, over `logs/` and `refs/` only — never `objects/`, which is large and which a fast-forward does not need to write.

Two properties of that walk are load-bearing and neither is obvious. It uses `lstat`, so a symlink is judged by **its own** ownership and is never followed — no loops, and nothing outside the repo gets walked. And it **reports a directory it cannot list rather than throwing**: an unreadable root-owned directory is a likely symptom of the very state being looked for, and this runs at the end of an install that has already started the service, so throwing would fail a good install on the evidence it was called to report.

`.git` itself is checked too, but **without recursing** — walking it would drag `objects/` in for nothing, since a pull never rewrites the directory itself. It still has to be looked at: a root-owned `.git` over owner-owned contents is equally unpullable, and the walk cannot see it. ⚠️ In a linked `git worktree` all these paths are absent and the probe quietly finds nothing — that is the shape agents develop in, not the shape the Pi runs.

## What matching the user to the owner bought

Three mechanisms collapsed into one, which is the argument for this being the right layer rather than a third workaround:

- **`-c safe.directory` is unnecessary.** It was only ever needed because the pulling uid did not match the owner — i.e. it was a flag suppressing a warning about the exact hazard that then bit us. A workaround that exists to silence a warning about a real hazard deserves more suspicion than it got.
- **`GIT_SSH_COMMAND` is unnecessary.** An earlier fix named `pi`'s key and `known_hosts` explicitly (`ssh -i /home/pi/.ssh/id_ed25519 -o UserKnownHostsFile=…`). Correct diagnosis, wrong layer: switching user makes the owner's `~/.ssh` reachable by definition. A **private** fork's deploy key now just works; a **public** fork can use an https remote and needs no key at all.
- **The scheme of `origin` stopped mattering.** https and ssh are both correct, so the installer tests the thing that is actually in question — whether `origin` is readable as that user — rather than pattern-matching the URL.

### ⚠️ `-H` is not what fixes ssh

Easy to assume and wrong, so it is worth stating: ssh follows the **effective uid**, so the user switch alone puts the owner's keys in reach. `-H` is there for what genuinely does read `$HOME` — git's own `~/.gitconfig`, and any credential helper. Measured against a switched uid:

|                          | `$HOME`             | ssh's `known_hosts` |
| ------------------------ | ------------------- | ------------------- |
| `sudo -u '#N' -H`        | target user's       | target user's       |
| `sudo -u '#N'` (no `-H`) | **invoking** user's | target user's       |

Delete `-H` and ssh keeps working, which is exactly how it would get deleted for the wrong reason.

## Other decisions

**`--ff-only`.** A diverged checkout fails loudly instead of building a merge commit on a bike that nobody is there to review. This repo's agent workflow force-pushes branches, so divergence is a real case, not a theoretical one — `deployHint()` names the way out (`fetch` + `reset --hard '@{u}'`). ⚠️ `@{u}`, not `origin/HEAD`: the latter is pinned at clone time to the _default_ branch, so on a Pi parked on a test branch that advice would silently replace the tree with `main`'s content.

**The uid comes from `stat()`ing the checkout, not from a hardcoded `pi`.** The invariant is _"the puller is the owner"_; a hardcoded name reintroduces the same bug mirrored the moment a checkout belongs to someone else, and does it silently. It also makes the behaviour testable — there is no `pi` user on a laptop or in CI, but there is always an owner. ⚠️ It stats the **worktree root**; the invariant is really about the object store, and the two diverge in a linked `git worktree` (where `.git` is a file pointing elsewhere) and in a checkout whose `.git` was chowned separately.

**`-n` on sudo.** A sudo that would need a password fails at once instead of hanging until the 60 s timeout on a prompt no phone can answer. Root needs no password, so this never fires on the Pi.

**No `GIT_TERMINAL_PROMPT=0`.** It would be stripped by sudo's `env_reset` anyway. It is also unnecessary: git prompts via `/dev/tty`, a systemd service has none, and sudoers' `use_pty` (default since sudo 1.9.14) has no effect when sudo is not attached to a terminal. So a credential-wanting remote fails immediately regardless; `deployHint()` covers the wording.

**The button does not repair ownership itself.** A deploy path that silently rewrites file ownership is how this class of bug hides in the first place. It reports; a human chowns.

## Related

- [Checkout installation §3](checkout-install.md#3-get-the-code) — commands for an existing/development checkout.
- `scripts/check-update-endpoint.ts` — the checks, including the argv assertions that catch a regression to pulling as root.
- Issue #146 (the diagnosis and three rounds of review), PR #148.
- Issue #150 — `/update` now requires `X-Cool-Eva: update`, like `/fan` and `/vcu-write`. Without it a cross-origin `<form method="POST">` on any page the phone opened triggered this sudo pull and restart. ⚠️ It is a CSRF barrier and not authentication — a `curl` on the bike's wifi still reaches it, and so does the restart loop built on that. `docs/wifi-hardening.md`; asserted by `scripts/check-endpoint-headers.ts`.

> The following sections preserve the former README at commit `58c7eba` (2026-11-03), including dated measurements and limitations. For first installation, use the [current README](../README.md). Older validation/status claims are historical; the existing subsystem findings and current code take precedence.

## Running it

The app is the `cool-eva` `systemd` service on the Pi (Node 24, TypeScript run directly via `--experimental-strip-types`), serving `http://<pi>/` on port 80. For this historical checkout path, deployment is a pull and restart; bundle installs use the Update flow above:

```bash
git pull && sudo systemctl restart cool-eva
sudo journalctl -u cool-eva -f    # follow logs
```

A restart no longer re-initialises a healthy can0: since #160 the service reads the interface first and leaves it alone when it is already configured the way it would configure it, so a deploy should stop punching a five-second hole in the raw capture. It still bounces the link when it genuinely needs reconfiguring — and because it no longer bounces one that merely _looks_ healthy, "restart the service" is no longer the way to kick a wedged adapter: `sudo ip link set can0 down` first, or use the dashboard's CAN-restart button. ⚠️ **Unverified until the first deploy after this shipped** — the bike was powered down when it was written, so the fixtures behind it are synthetic. [`docs/can-capture.md`](can-capture.md) has the conditions, the residual hole and what that first deploy settles.

The dashboard menu's **Update** button does exactly that pull and restart from the phone, showing git's output. It runs the pull as the checkout's **owner** rather than as root — never `sudo git pull`, which poisons `.git` and makes the _next_ pull fail silently. [`docs/deploy.md`](deploy.md) has the why; [checkout installation §3](checkout-install.md#3-get-the-code) has what to type.

> ⚠️ **Don't run `npm install` or `npm ci` on the Pi unless a dependency actually changed.** `package-lock.json` is generated on macOS, where `socketcan`'s Linux-only native build is skipped as an optionalDependency; installing against that lockfile on the Pi deletes the real one, and the service then dies on boot with `ERR_MODULE_NOT_FOUND: socketcan`. `npm install socketcan` will insist it's "up to date" even with `--force` — the fix is `rm package-lock.json && npm install` **on the Pi** (~4 min). A plain `git pull` never touches `node_modules` and is always safe.

### Keep the checkout ready for updates after a dependency build

After deliberately rebuilding the Pi's dependencies with `rm package-lock.json` and `npm install`, run:

```sh
git checkout -- package-lock.json
```

This restores only the tracked lockfile. The freshly compiled native modules in `node_modules` remain in place. A regenerated lockfile left modified can make Menu → Update's `git pull --ff-only` refuse a later upstream lockfile change. The [checkout build steps](checkout-install.md#4-install-dependencies) include this restoration; do not run another dependency install merely because the tracked file has been restored.
