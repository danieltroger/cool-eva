# Release inputs cache

The release workflow caches inputs, not an executable builder image. Every consumer starts from the pinned ARM64 Debian image and verifies the restored bytes. A warm build needs no connection to snapshot.debian.org. GitHub [removes entries unused for more than seven days](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy), and storage pressure can evict them sooner. A dispatch after that quiet week cold-fills and needs snapshot metadata reachable. Actions caches are not permanent release assets.

## What is cached and checked

- Builder inputs: Node's pinned archive, the two signed Debian `InRelease` files, their package indexes, and exactly the `.debs` selected by the builder's package roots. The key includes the snapshot timestamp, base-image digest, exact roots file, repository digest pins, Node version/hash and verification recipe.
- QEMU/libslirp: only the two exact source tarball filenames, checked against the pinned setup recipe by the portable check. Their key covers that recipe. The existing SHA-256 checks run on hits and misses, before extraction. Compiled tools, Python environments and extracted source trees are not restored.

No broad restore keys are used. Consumers require an exact cache hit and fail rather than fetching missing inputs. Cache contents contain public upstream files, with no keys, ride data or credentials.

## Provenance on every builder use

The committed `builder-repositories.sha256` binds the signed metadata to the tested snapshot. APT reads the restored repository through `file:` and verifies its signatures using the archive keyring from the pinned base image, then verifies the package-index hashes. The historical snapshot keeps the existing `Check-Valid-Until: no` setting; signature and content verification remain enabled.

APT regenerates the install plan from those authenticated indexes and the immutable base image, using only `builder-packages.txt`. `Acquire::ForceHash=SHA256` makes its printed plan provide SHA-256 values. Each required cached archive must match its size and hash, and the entire archive filename set must match the plan. No cached manifest determines which packages to install. Extra archives, changed bytes and symlinks are rejected.

Installation uses `apt-get --no-download`; the Docker build and separate verification containers use `--network=none`. `--no-cache` on the Docker build ensures a prior layer cannot skip verification. Node's archive is also rehashed against its committed pin, both before the build and inside the image.

The `cache-proof` job exercises a real offline installation and rejects changed `.debs`, changed package indexes, changed Release bytes, invalid signatures and extra packages. A fetch attempted inside the offline container must fail, using the same network-isolation arguments as the builder. Its signature case deliberately updates the digest pin in a throwaway recipe to prove that APT's signature verification independently rejects the altered signed message. No repository files are changed by these tests.

The relevant upstream source is [APT 3.0.3's install URI printing and hash selection](https://github.com/Debian/apt/blob/3.0.3/apt-private/private-install.cc#L230) and [authenticated file download helper](https://github.com/Debian/apt/blob/3.0.3/cmdline/apt-helper.cc#L55), opened when implementing this cache. The explicit SHA-256 option overrides APT's MD5 default for printed URIs.

## Cold fill and cache scope

Only the `inputs` job fills a miss. It uses the original signed snapshot to obtain the package plan. Cold archive downloads retain `Acquire::Retries=5`, both from snapshot and from the fallback. A package download can fall back to Debian's official pool only for the same path and exact authenticated SHA-256; there is no substitution with a newer version. That pool may no longer retain an older package, so it cannot replace snapshot permanently. If neither source can supply those bytes, the fill fails. Only a fully verified cache is saved, before the long installer VM gate, so a later test failure does not discard the downloads.

GitHub [scopes PR caches to their merge ref](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache). A main push affecting the pinned recipe warms the default-branch cache; it does not run a publication job. That helps subsequent PRs and cuts while those inputs remain cached. It does not guarantee a hit at the next release after an idle week. This is change-triggered work, with no schedule.

The `bundle` and `cache-proof` jobs restore those exact inputs. The proof job has no dependency on the runtime gate and can be run again independently to demonstrate a warm hit without retrying a guest/runtime fault. Publication still requires the existing explicit manual dispatch and channel guards, plus the proof job.

## Release checklist

1. When choosing to publish, start the explicit release dispatch and check its `inputs` cache-preflight job first. It runs before the bundle and publication jobs. A recent main-push input run can already have warmed the same keys, but an idle week, eviction or changed pins means a cold fill.
2. Wait for `inputs` to succeed. If snapshot metadata is unavailable on a cold fill, the job fails before publication: wait for the service to recover, then rerun the authorized release run. No schedule keeps the cache warm, and inputs are not published as separate release assets.
3. After that preflight succeeds, the remaining build, installer and proof gates run before publication. A warm cache removes snapshot from these consumers, not from every future release cut.

## Local use and pin changes

From the repository root, bootstrap once, then build normally:

```sh
node --experimental-strip-types scripts/release/cache.ts fetch dist/release-inputs
node --experimental-strip-types scripts/release/build.ts dist/release
```

The build requires committed source changes and uses the verified cache without fetching. To check an existing cache or run the full offline/tamper proof:

```sh
node --experimental-strip-types scripts/release/cache.ts verify dist/release-inputs
sh scripts/install-check/setup-tools.sh dist/qemu-tools fetch-only
node --experimental-strip-types scripts/release/cache-proof.ts dist/release-inputs dist/qemu-tools
```

Changing the snapshot requires updating the two metadata digests from freshly APT-authenticated `InRelease` files for that snapshot. Review those pins alongside the builder image and package roots. Ordinary application commits reuse the same cache. Docker Hub, npm, the official image and live Pi OS repositories remain separate release-time dependencies, as do PyPI (Meson and Ninja) and the runner's Ubuntu apt repositories for the QEMU host build. This cache removes repeated snapshot package downloads rather than guaranteeing every external service stays available.
