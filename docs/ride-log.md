# Ride logs

Encryption here applies to the sealed `.celog` files. The optional [raw CAN capture](can-capture.md) is a separate artifact and can contain personal telemetry; it is not made confidential by sealing the ride log. Keep raw captures private.

> The following sections preserve the former README at commit `58c7eba` (2026-11-03), including dated measurements and limitations. For first installation, use the [current README](../README.md). Older validation/status claims are historical; the existing subsystem findings and current code take precedence.

The sealed ride log can be downloaded from `http://<pi>/dl` — short enough to type on a phone, and ~10x smaller than the old SQLite download. What crosses the wire is ciphertext: without the laptop's private key those bytes are noise. That is a claim about the **bytes**, not about the **transfer** — `/dl` is unauthenticated plain HTTP, so anyone on that network can pull the whole log and keep the ciphertext against the day the key leaks, and anyone in the middle can truncate it, because segments are sealed one by one and nothing signs the sequence. See [What this does and doesn't hide](#what-this-does-and-doesnt-hide). Decrypt it on the laptop (see below) to get a `.db` for Grafana.

## Encrypted ride log

A stolen bike is a stolen SD card, and the log holds every route you've ridden — including the one that ends at your front door — plus the ID of the key fob that starts it. So the Pi can be given a **public key only**: it seals every reading it writes and cannot read any of it back.

Set it up once, on the laptop:

```bash
node --experimental-strip-types scripts/generate-log-key.ts   # writes both keys
# back the PRIVATE key up (password manager) — it is the only thing that can ever read the logs
scp ride-log-key.public.pem pi@cool-eva.local:/home/pi/cool-eva/
```

The pair is generated on the laptop and never on the Pi, deliberately: the bike is supposed to hold a public key only, and a Pi that generated the pair would have had the private half on the SD card — which is exactly what the sealed log exists to make worthless. `scripts/setup-service.ts` checks for the key and prints these commands with your hostname filled in if it's missing.

Restart the service; it logs `ride-log: encrypting to …` once it finds the key. Sealed segments land in `ride-logs/*.celog`. To read them back:

```bash
# a /dl download is a single file; ride-logs/ off the Pi is a directory — both work
node --experimental-strip-types scripts/decrypt-log.ts cool-eva-2026-08-01.celog
node --experimental-strip-types scripts/decrypt-log.ts ride-logs/ --out rides.db

# the key is looked up relative to the CWD, so from anywhere else:
RIDE_LOG_PRIVATE_KEY=~/Documents/cool-eva/ride-log-key.private.pem \
  node --experimental-strip-types scripts/decrypt-log.ts ~/Downloads/cool-eva-2026-08-01.celog
```

That rebuilds an ordinary SQLite file, so Grafana and the dashboards work against it — with one exception since the route map's track was materialised: its map panel and its "GPS points mapped" tile read a `route_track` table that only the import step builds, and both show an error badge until `scripts/import-ride-log.ts --materialise-only <db>` has been run against the file. ⚠️ And a `--force` decrypt into a database that already has that table leaves it **stale** rather than absent, which looks like nothing at all — `docs/route-map.md` §"If the table is missing" has the measurement.

> ⚠️ Decrypting **refuses** an existing `--out` — delete it, choose another name, or pass `--force`, which **appends** and will happily store a second copy of everything the file already holds. Point it at a fresh file rather than at an existing archive you care about, and use `scripts/import-ride-log.ts` (§Grafana) when the archive you care about is the one being replaced. The Grafana datasource reads `/repo/rides.db`, which is why the walkthrough above uses that name. The sealed log is also **~10x smaller** than the equivalent SQLite (gzip before encryption, and crypto overhead is per 30-second segment rather than per row).

Each segment uses a fresh ephemeral X25519 key (ECDH → HKDF-SHA256 → AES-256-GCM), so compromising the Pi cannot retroactively decrypt anything already written. Segments are independently sealed, so damage is contained: the reader resyncs on the next segment and reports what it couldn't read rather than stopping. **There is deliberately no recovery path: lose the private key and every logged ride is gone forever.** That is exactly what makes the SD card worthless to a thief.

### What this does and doesn't hide

Holds up: the readings themselves — routes, coordinates, the key-fob ID, everything in the tables above. Whoever takes the SD card, or intercepts a `/dl` download, gets ciphertext.

Does not:

- **Timing metadata leaks.** Filenames are `rides-YYYY-MM-DD.celog` — plus `rides-boot-<session>.celog` for whatever was sealed before the clock could be believed, which leaks a boot count rather than a date (`docs/ride-log-clock.md`) — and sizes scale with how much was logged. That reveals which days the bike moved and roughly for how long, without revealing where. Since the motivating worry is someone learning your habits, that's worth knowing.
- **No cross-segment integrity.** Each segment is authenticated on its own, so tampering within one is detected — but segments can be deleted or reordered without the reader noticing. It protects confidentiality, not completeness.
- **`/dl` is unauthenticated** on port 80, like the rest of the server. The payload is sealed, so the exposure is the metadata above rather than the data — but it's a wider audience than "whoever holds the SD card".

- Coolant history predating the CAN integration is preserved (migrated into the current schema; the original table is kept as a backup).
- Any `temperatures.db` left on the Pi from before the encrypted log is **plaintext history** — copy it off and delete it from the bike, or the SD card still gives up every route you rode before the switch.
