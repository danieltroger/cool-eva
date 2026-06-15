# Cool Eva — agent guide

Pi-based telemetry for a watercooled Energica Eva Ribelle: MAX31865 coolant probes

- Energica CAN/OBD telemetry → SQLite (log-on-change) → a live phone dashboard (WebSocket) and Grafana. See `README.md` for the overview and `obd-garage/CAN_MAP.md` for the reverse-engineered CAN map.

## Conventions

- **Descriptive names.** Use full, meaningful variable and function names. Avoid cryptic one- or two-letter names (`d`, `s`, `cfg`, `cl`, `kw`, …) — spell it out (`data`, `signal`, `tileConfig`, `chargeText`, `kilowatts`). Tiny throwaway math helpers/indices are the only exception, and only when the meaning is obvious.
- **No synchronous blocking calls.** Never use `execSync` / `readFileSync` / `writeFileSync` / any `*Sync` or other blocking API in the app — they stall the event loop, which also serves the WebSocket and the CAN RX handler. Use async/promises; top-level `await` is available (ESM, Node 24). **Only exception:** `better-sqlite3`, which is intentionally synchronous.
- **Braces for control flow.** Always wrap `if` / `else` / `for` / `while` bodies in braces, even one-liners. The only exception is a bare `continue`, `return`, or `break`, which may stay brace-less on the same line.
- Run `npm run typecheck` before committing.

## Runtime notes

- Runs as the `thermometer` systemd service on the Pi (Node 24, TypeScript via `--experimental-strip-types`). Relative imports use explicit `.ts` extensions.
- `socketcan` is an optionalDependency (Linux-only native build) with a type shim in `src/types.d.ts`, so `tsc` / `npm ci` still work on macOS and CI.
