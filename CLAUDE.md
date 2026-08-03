# Cool Eva — agent guide

Pi-based telemetry for a watercooled Energica Eva Ribelle: MAX31865 coolant probes

- Energica CAN/OBD telemetry → SQLite (log-on-change) → a live phone dashboard (WebSocket) and Grafana. See `README.md` for the overview and `obd-garage/CAN_MAP.md` for the reverse-engineered CAN map.

## Conventions

- **Descriptive names.** Use full, meaningful variable and function names. Avoid cryptic one- or two-letter names (`d`, `s`, `cfg`, `cl`, `kw`, …) — spell it out (`data`, `signal`, `tileConfig`, `chargeText`, `kilowatts`). Tiny throwaway math helpers/indices are the only exception, and only when the meaning is obvious.
- **No synchronous blocking calls.** Never use `execSync` / `readFileSync` / `writeFileSync` / any `*Sync` or other blocking API in the app — they stall the event loop, which also serves the WebSocket and the CAN RX handler. Use async/promises; top-level `await` is available (ESM, Node 24). **Only exception:** `better-sqlite3`, which is intentionally synchronous.
- **Braces for control flow.** Always wrap `if` / `else` / `for` / `while` bodies in braces, even one-liners. The only exception is a bare `continue`, `return`, or `break`, which may stay brace-less on the same line.
- **Never swallow errors.** No empty `catch {}`, and no `catch` whose body is only a comment — that hides failures we may well care about later, on a bike we can't attach a debugger to. If a failure is genuinely expected and recoverable, log it (`console.warn`, or `console.log` when it's routine) with enough context to identify which call failed, then carry on. If a failure "can't happen", that is exactly why it must be loud when it does. Catching to keep the process alive is fine; catching to stay quiet is not.
- **No `object` or `any` type annotations.** They switch off type checking exactly where it matters — a WebSocket payload typed `object` lets any typo through. Use a named type/interface, a precise shape, `Record<K, V>`, or `unknown` + narrowing. The one accepted `any` is variadic logger-style `...args: any[]`.
- **Main function at the top of the file.** Export the primary function first; helpers go below it (function declarations hoist) or into their own files.
- **Don't nest function declarations.** Helpers live at module level taking explicit parameters (a shared context object is fine) so their inputs and outputs are visible at a glance. Nesting is reserved for closures that genuinely earn their keep — e.g. `runSession` in `src/ble/client.ts` closes over the session's stop flag for its whole lifetime.
- **Split files early.** Once a file passes ~400 lines or grows a second distinct responsibility, move the newcomer into its own module — the way BLE protocol decoding (`ble/protocol.ts`), the D-Bus link (`ble/client.ts`), adapter bring-up (`ble/adapter.ts`) and clock stepping (`ble/clock.ts`) are separate. Prefer many small single-purpose files over one that keeps accreting; a moved-out function takes what it needs as explicit parameters rather than reaching back into a shared object.
- **Keep decoders pure.** Frame/PID decoding takes bytes and returns values with no I/O, clock reads or side effects (`ble/protocol.ts`, `can/decode.ts`). That's what makes it testable by replaying captured frames when the bike is out of reach — which is how the GPS decode was verified.
- **Comments explain constraints the code can't express** — hardware quirks, protocol bugs, why a magic constant is what it is — not what the next line does.
- **The WebSocket wire shape is a named type** (`DashboardMessage` in `src/ws.ts`), never an inline object literal. The dashboard has no build step, but it is not untyped: `tsconfig.json` sets `checkJs` over `public/**/*.js`, and the modules pull the type in through JSDoc (`/** @typedef {import("../../src/ws.ts").DashboardMessage} … */` in `public/lib/store.js`). Change the wire shape and `npm run typecheck` fails — so keep it that way rather than reintroducing a hand-copied shape.
- **The dashboard is ES modules in `public/`, no build step and no VDOM.** What is committed is what the browser runs, so deploy stays a `git pull` and it can be edited over ssh in the garage. The only dependency is VanJS, vendored verbatim in `public/vendor/` and excluded from Prettier. Views bind per signal; anything a binding needs to _sample_ rather than _react to_ uses `peek()` from `public/lib/store.js`, never `valueOf()` — VanJS registers a dependency in the `val` getter, so reading a signal inside a chart or timer binding silently paces it at frame rate.
- **Filter readings before displaying them.** Real data contains sentinels and dead sensors (`coolant_in` at −242 °C for 59 450 rows, `0xFFFF` cell voltages, `high_beam` reading 193). `public/lib/bounds.js` gates every signal against a physical range; a rejected value is shown as a fault, never clamped into something plausible and never silently dropped.
- Run `npm run typecheck` and `npx prettier --write` on changed files before committing (CI runs `format:check`).

## Runtime notes

- Runs as the `thermometer` systemd service on the Pi (Node 24, TypeScript via `--experimental-strip-types`). Relative imports use explicit `.ts` extensions.
- `socketcan` is an optionalDependency (Linux-only native build) with a type shim in `src/types.d.ts`, so `tsc` / `npm ci` still work on macOS and CI. `node-ble` is pure JS over D-Bus, so it needs no native build and is a normal dependency.

## Deploying to the Pi (learned the hard way)

- Deploy is a `git pull` in `/home/pi/thermometer` on the Pi, then `sudo systemctl restart thermometer`. Logs: `journalctl -u thermometer -f`. To try a branch, check it out on the Pi the same way: `git fetch origin && git checkout <branch> && git pull`.
- **Only run `npm install` on the Pi when a dependency actually changed** — and check `node_modules/socketcan/build/Release/can.node` still exists afterwards. `package-lock.json` is committed but generated on macOS, where `socketcan`'s Linux-only native build is skipped as an optionalDependency; installing against that lockfile on the Pi prunes the real one, and the service then dies on boot with `ERR_MODULE_NOT_FOUND: socketcan`. `npm install socketcan` will keep insisting it's "up to date" — even with `--force`. The fix is `rm package-lock.json && npm install` **on the Pi** (~4 min, rebuilds the native module). A plain `git pull` without `npm install` is safe: it never touches `node_modules`.
- **Restarting the service re-initialises `can0`**, which kills any other raw-CAN socket with `OSError 100 Network is down`. Expected when you have a scratch script running, not a fault.
- **The Connectivity Hub accepts one BLE connection at a time** and the service holds it. Stop the service before running a scratch BLE probe, or the two fight over the link.
- There's no reception in the garage — the Pi is only reachable when the bike is parked within wifi range.
