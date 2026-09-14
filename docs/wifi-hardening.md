# Who can reach the Pi, and what they can do when they get there

The Pi serves the dashboard to **anyone on the bike's wifi**, unauthenticated, and that is deliberate: the alternative is typing a password on a phone in gloves, in a garage, to look at a coolant temperature. What is not deliberate is a page on some _other_ origin being able to press the dashboard's buttons without the rider's knowledge, and that is what this file is about.

Written while closing #92, #150, #130 and #129, which are four descriptions of the same surface.

## The one mechanism, and its exact limit

Every endpoint that changes something requires a header: **`X-Cool-Eva: <its own value>`**.

**⚠️ It is a CSRF barrier, not authentication.** What it stops:

- A cross-origin `<form method="POST" action="http://cool-eva.local/update">` on any page the rider's phone opens while on the hotspot. A form **cannot set a header**, so a form POST is a _simple_ request that this server would otherwise answer.
- A cross-origin `fetch` with the header. A custom header name makes the request non-simple, so the browser preflights with `OPTIONS` — and `src/index.ts` has no `OPTIONS` branch, so the preflight is never answered and the real request is never sent.

CORS would not have helped: it stops the attacker **reading the reply**, and the side effect has already happened by then.

What it does **not** stop, and nothing here does:

- `curl -H 'X-Cool-Eva: update' http://cool-eva.local/update` from anyone on the wifi.
- Therefore **#150's second point survives this**: repeat that POST and the service restarts for as long as someone keeps it up, which is the cheapest denial of service on the bike's telemetry. Closing #150 closed the drive-by, not the DoS.

The header **values differ per endpoint** so a caller built for one cannot reach another; the **name is shared**, because the name is the whole of what forces the preflight. `scripts/check-endpoint-headers.ts` §1 reads every `*_HEADER_VALUE` out of `src/http/` and asserts they are all distinct, over a floor so that a regex which matched nothing cannot pass in silence.

## Every route, and what stands in front of it

| Route | Reaches | Guard |
| --- | --- | --- |
| `/` and static | the phone | none needed |
| `/status`, `/dl` | stored state, the sealed ride log | none — reads. ⚠️ `/dl` authenticates nobody; the log is unreadable without the laptop's private key, but the ciphertext is pullable |
| `/dtc-table`, `/fault-infokeys`, `/lifetime-stats`, `/vcu-params`, `/stored-dtcs`, `/vcu-backup.csv` | stored snapshots and static tables | none — `/lifetime-stats`' handler takes no `req` at all, so "cannot reach the bus" is type-checked rather than promised |
| `/waypoint` | the ride log (GPS) | **none, and it ignores `req.method`** — see below |
| `/can-restart` | the Pi's CAN interface | `X-Cool-Eva: can-restart` (#150) |
| `/update` | `sudo git pull` + `systemctl restart` | `X-Cool-Eva: update` (#150) |
| `/fan` | the Pi's GPIO | `X-Cool-Eva: fan` |
| `/charge-auto` | the charge controller's on/off | `X-Cool-Eva: charge-auto` |
| `/lifetime-read`, `/vcu-read`, `/vcu-probe` | **the bike's bus**, read-only | `X-Cool-Eva: service-mode`, plus the server-side service gate. ⚠️ On `/vcu-read` the guard is on the **POST only** (`src/http/vcu-read.ts`); its `GET` and `DELETE` fall through without it, and neither reaches the bus |
| `/vcu-write` | **the bike's bus**, writing | `X-Cool-Eva: service-write`, plus the gate, plus a confirm token |

## The WebSocket: one frame used to be enough (#92)

Fixed before this track began, in #87 (`bc2b100`), and recorded here because a fix nobody can find gets re-derived.

`ws` reports a refused or malformed frame as an `error` event on the **per-connection** socket, and an `EventEmitter` with no `error` listener makes Node throw. Nothing listened. One frame with RSV1 set, from anyone on the wifi, exited the process — taking ride-log sealing and the CAN capture with it, not just the phone's screen.

`src/ws.ts` now has the listener inside `wss.on("connection")`, a second one on the server itself that **rethrows when `server.listening` is false** (a failed bind must stay fatal — systemd restarts a failed unit, not a running one serving nothing), and `maxPayload: MAX_CLIENT_FRAME_BYTES`. The cap and the listener are one change, not two: capping without listening made the _easy_ trigger fatal.

`scripts/check-connection.ts` §9 pins it permanently, and it really does fail: deleting the four lines of `ws.on("error", …)` takes the check to **exit 1** with `a malformed frame does not take the service down either` red — the exact row of #92's own table.

## Two taps, on the two that had one (#130)

`/update` replaces the code the bike runs; `/can-restart` drops the link and every other socket on it. Both fired on a **single tap** from a phone living in a pocket, while the read-only parameter sweep above them already took two. They now go through `public/lib/arming.js` with keys of their own, so they get the measured 400 ms dwell and the held-Enter refusal that every other second tap on this dashboard gets.

They stayed **grey**, not amber: `.action.writes` on this sheet means "this touches the motorcycle", and neither of these does. The tap count and the tier are separate channels — the sweep is the precedent, arming while grey. The argument lives in `docs/dashboard-decisions.md` § "The menu sheet".

`public/views/pi-actions.js` is new and holds both, split out of `views/sheet.js` for CLAUDE.md's ~400-line rule and because maintaining the Pi **as a computer** — its CAN interface, its checkout, its systemd unit — is a responsibility of its own. Not "the controls that act on the Pi": the waypoint and the ride-log download act on the Pi too, and stayed in the sheet. The line is maintenance of the machine, not use of it.

`src/can/restart.ts` is also new, and is a pure move of `restartCanLink` out of `src/can/socket.ts`. That file imports `socketcan`, a Linux-only native build carried as an optional dependency — so anything reaching the restart through it dragged that binding along, and `src/http/can-restart.ts` could not be loaded on a Mac at all. Shelling out to `ip` needs no native module; opening a raw channel does.

## Surveyed, not fixed

**`GET /waypoint` ignores `req.method` entirely** (`src/index.ts`, `src/http/waypoint.ts`), so a cross-origin `<img src="http://cool-eva.local/waypoint">` writes a waypoint row into the ride log. Filed as **#239** rather than fixed here, for a reason worth keeping: the header-free, body-less GET **is** the Siri Shortcut's contract, written down in that file — one "Get Contents of URL" action and a plain-text reply Siri reads aloud, which is the only feedback available with the phone in a pocket and gloves on. A required header breaks it, and what the attack buys is a spurious GPS row. The options, including a URL token, are on the issue.

**The dashboard is still unauthenticated**, on purpose. Everything above assumes the attacker is _a page_, not _a person on the wifi_. A person on the wifi can `curl` every endpoint in the table.

## Where the checks are

- `scripts/check-endpoint-headers.ts` — the guard on `/update` and `/can-restart`, both ends, and the distinctness of every header value.
- `scripts/check-fan-endpoint.ts` §2 — the same for `/fan`, and where the both-ends-pinned-to-a-literal lesson was first written down.
- `scripts/check-connection.ts` §9 — that a client cannot kill the service.
- `scripts/check-arming.ts` — the two-tap gate, including the eleven firing sites and the fact that re-opening the menu sheet disarms.

⚠️ `check-arming.ts` discovers its consumers by reading `public/`, but §5's key scrape is a **hand-maintained list of three files**. It cannot simply be derived from the discovered consumers: `views/charge-current.js` and `views/charge-stop.js` export `ARMED_KEY`, which matches the same `\w+_KEY` pattern and would double-count into the uniqueness test it feeds. A new arming surface in a new file still has to be added there by hand, and nothing catches its absence.
