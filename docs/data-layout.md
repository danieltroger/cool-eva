# Persistent data layout

The shared data root is **`/var/lib/cool-eva`**, outside every checkout and release. The settings service owns this layout and the one-time move. The #324 installer invokes or waits for that migration and verifies its result; it never runs another mover or maintains another data-move journal. Its updater must follow this contract.

`archive-group` below means the checkout owner's primary group on an existing install, or the installing user's primary group on a fresh install. Resolve its numeric GID before replacing the checkout and retain it in `state/installed.json`. The service and capture writer run as root. Settings and credentials remain private; the archive owner can still pull data over SSH.

| Path relative to `/var/lib/cool-eva/` | Owner:group | Mode | Contents |
| --- | --- | --- | --- |
| `.` | `root:archive-group` | `0750` | Stable data root; display-only in Advanced |
| `state/` | `root:root` | `0700` | Private service state |
| **`state/settings.json`** | `root:root` | `0600` | Canonical settings, including credentials |
| `state/installed.json` | `root:root` | `0600` | Prior-install marker and archive ownership |
| **`state/data-move.json`** | `root:root` | `0600` | The sole one-time data-move journal |
| `ride-logs/` | `root:archive-group` | `2750` | Encrypted ride archives |
| `vcu-params/` | `root:archive-group` | `2750` | Snapshots, partial reads, preferences and change history |
| `wifi-diag/` | `root:archive-group` | `2750` | Wi-Fi diagnostic dumps; location is display-only |
| `captures/` | `root:archive-group` | `2750` | Raw compressed CAN captures |
| `updater/` | `root:root` | `0700` | Reserved exclusively for #324's updater state/cache/rollback snapshots |

Archive subdirectories retain `root:archive-group` and `2750`; archive files are `root:archive-group`, `0640`. Setgid makes new entries inherit the reader group. The archive group may delete pulled captures through the fixed, no-argument `sudo -n /usr/local/libexec/cool-eva-prune-captures` helper; no sudo prompt or directory write permission is required. The helper accepts validated basenames on stdin, refuses links and the current boot, and can unlink only within `captures/`.

Archive writers use `UMask=0027`; replacements preserve/set the group and access. The archive owner has read/traverse access, not directory write access, so cannot plant links where root appends. Enforce existing modes explicitly. Files beneath `state/` and `updater/` are `0600`, directories `0700`; #324 owns names beneath `updater/`, but cannot place a second data-move journal there. No updater cleanup follows links into or deletes persistent data.

## One-time move and overrides

Before writers start, the service maps old default `ride-logs/`, `vcu-params/` and `wifi-diag/` beneath the old code directory, and the capture writer's existing `/home/pi/ride-captures`, into the four archive directories above. Quiesce **both** the telemetry and capture writers. Journal source, destination and identity before moving; on the same filesystem rename each directory and fsync both parents. Resume a cut between rename and settings commit from that journal. Never overwrite or merge an unrelated destination. Cross-filesystem migration retains the old path with a visible fault until an offline verified move can complete; it must not hide the dashboard for a long copy. Release cleanup waits for the one completed move. Rollback uses that same data, never rewinds it, and never starts writers against an unfinished move. Compatibility links at old default paths support older code; cleanup removes those links without traversing their targets.

An **explicit non-default recording or service-data path stays in place**; no silent move or permission rewrite of that external storage. Resolve symlinks so a retained path does not depend on a checkout link. If an override lies inside code scheduled for deletion, report it and block release cleanup until the owner chooses an external location. Only recording and service-data locations are editable. The root, Wi-Fi diagnostic location and capture location are derived.

The runtime writer lock is `/run/cool-eva/settings.lock`, root-owned beneath a `0700` directory; it is not a second migration journal. Sweep only recognised replacement-temp filenames in known managed directories while holding this lock. A card reflash still needs backup/restore.

This document specifies the storage-phase contract. The preparatory PR adds the modules/checks; the existing runtime/unit wiring changes only in the atomic cutover.
