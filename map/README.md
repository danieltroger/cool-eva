# `map/` — a fast ride map for `rides.db`

A laptop-side viewer for the decrypted ride log: the whole archive's track, the charge stops,
the waypoints and a ride list, drawn with MapLibre. It replaces the Grafana route-map dashboard
for looking at where the bike went, and it exists because that dashboard takes 12.3 s to a
painted map while ~85 % of the wait is Grafana's own pipeline rather than the database.

```bash
npm run map          # from the repo root: installs this package, then starts it
```

Then open the URL it prints. ⚠️ Vite listens on **IPv6 loopback only** — `localhost` works,
`127.0.0.1` is refused.

- **`RIDES_DB`** overrides the database path, which defaults to `rides.db` at the repo root.
  Needed when running from a git worktree, where the real archive is in the main checkout.
- **`rides.db.mapcache`** appears beside the database: the rides / charges / waypoints snapshot,
  keyed on the file's inode, size, mtime and a hash of the queries. Building it takes ~23 s on
  the real archive; after that it loads in ~4 ms. Delete it and it rebuilds. It is gitignored by
  the root `.gitignore`'s `rides.db*`.
- **The database is opened read-only** (`query_only`), and nothing here ever writes to it.
- **Tiles need internet.** The basemap is OpenFreeMap's public instance; offline, everything but
  the basemap still works. An offline PMTiles extract is phase 2 of #296.

`npm run lint`, `npm run check` and `npm run build` are what CI runs (`.github/workflows/map.yml`).
This is its own npm package with its own lockfile and is deliberately **not** an npm workspace,
so none of it reaches the root lockfile the Pi installs from.

**Every measurement behind this, and the defects found building it, are in
[`docs/ride-map.md`](../docs/ride-map.md).** Read that before changing the track pipeline.
