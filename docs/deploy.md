# Deploying to the Pi — who pulls, and why it is not root

The dashboard's **Update** button (`src/http/update.ts`) is a `git pull` and a `systemctl restart`. This file is why it is shaped the way it is. Operator instructions — what to actually type on a fresh Pi — are in `INSTALL.md` §3; this is the reasoning behind them, kept here so the next person changing the mechanism does not have to re-derive it from six copies scattered across the repo.

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

- `INSTALL.md` §3 — what to type, for an operator setting up a Pi.
- `scripts/check-update-endpoint.ts` — the checks, including the argv assertions that catch a regression to pulling as root.
- Issue #146 (the diagnosis and three rounds of review), PR #148.
- Issue #150 — `/update` has no `X-Cool-Eva` guard, unlike `/fan` and `/vcu-write`.
