import type { IncomingMessage, ServerResponse } from "http";
import { CHARGE_AUTO_REASON, MIN_COMMAND_A } from "../charge/auto-curve.ts";
import type { ChargeAutoMode, ChargeAutoState, ChargeAutomatic } from "../charge/auto.ts";

// /charge-auto — the switch for the automatic DC charge-current controller.
//
//   GET   what it is doing and why. Touches nothing.
//   POST  ?mode=automatic | off
//
// ⚠️ It does NOT command a current itself. Everything reaching the bus goes through /vcu-write's
// `charge-current` action and its five locks; this only decides whether the controller may use
// them, which is why it is a separate smaller door rather than another verb on the write endpoint.
//
// ⚠️ POST wants CHARGE_AUTO_HEADER for the reason src/http/fan.ts spells out at length: no CORS
// headers, no auth, so a custom header name is what forces a preflight this server never answers.
// And switching to `off` does not undo a current already commanded — the setting is transient and
// the rider takes it back on the bike's own dial. docs/charge-auto.md.

/** The header a POST must carry. Its own value, so a caller built for another endpoint cannot reach this. */
export const CHARGE_AUTO_HEADER = "x-cool-eva";

export const CHARGE_AUTO_HEADER_VALUE = "charge-auto";

export interface ChargeAutoResponse {
  state: ChargeAutoState;
  /** The reason as one sentence. On the wire so the browser needs no copy of the enum's prose. */
  reasonText: string;
  /** The floor it will never command below, so the page can say what "at the floor" means. */
  floorAmps: number;
  /** Why nothing was changed, when a POST was refused. */
  message: string | null;
}

export async function handleChargeAutoEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  automatic: ChargeAutomatic
): Promise<void> {
  if (req.method === "GET") {
    respond(res, 200, automatic.state(), null);
    return;
  }
  if (req.method !== "POST") {
    respond(res, 405, automatic.state(), `${req.method} is not a thing this endpoint does.`);
    return;
  }
  if (req.headers[CHARGE_AUTO_HEADER] !== CHARGE_AUTO_HEADER_VALUE) {
    respond(res, 403, automatic.state(), `A POST here wants the ${CHARGE_AUTO_HEADER} header.`);
    return;
  }
  const mode = url.searchParams.get("mode");
  if (mode !== "automatic" && mode !== "off") {
    respond(res, 400, automatic.state(), `mode must be "automatic" or "off", not ${JSON.stringify(mode)}.`);
    return;
  }
  automatic.setMode(mode as ChargeAutoMode);
  // Read back rather than echoed: `CHARGE_AUTO_ENABLED=0` pins the mode off, and the page must show
  // what the Pi will actually do rather than what it was asked for.
  const state = automatic.state();
  const refused =
    state.mode !== mode ? "The env var CHARGE_AUTO_ENABLED is 0 on this Pi, so the controller stays off." : null;
  respond(res, 200, state, refused);
}

function respond(res: ServerResponse, status: number, state: ChargeAutoState, message: string | null): void {
  const body: ChargeAutoResponse = {
    state,
    reasonText: CHARGE_AUTO_REASON_TEXT[state.reason] ?? "",
    floorAmps: MIN_COMMAND_A,
    message,
  };
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * One sentence per reason, for the charge tab.
 *
 * ⚠️ The ONLY copy of this prose. It used to be mirrored by hand in public/views/charge-auto.js as
 * well, on the fan's `FAN_REASON`/`fan-display.js` precedent — but that pair exists because the fan's
 * codes never travel over HTTP. These do, so sending the sentence is strictly better than keeping a
 * second table in a file that cannot import the enum.
 */
export const CHARGE_AUTO_REASON_TEXT: Record<number, string> = {
  [CHARGE_AUTO_REASON.DISABLED]: "Off — the bike charges as it normally would.",
  [CHARGE_AUTO_REASON.NOT_DC]: "Waiting for a DC fast charge.",
  [CHARGE_AUTO_REASON.NO_TEMPERATURE]: "No trustworthy pack temperature — not commanding anything.",
  [CHARGE_AUTO_REASON.NO_CEILING]: "The DC ceiling has not arrived, so there is nothing to command against.",
  [CHARGE_AUTO_REASON.RIDER]: "You set the current on the bike — stood down for this charge.",
  [CHARGE_AUTO_REASON.NO_HISTORY]: "Watching. Not enough temperature history yet to see a trend.",
  [CHARGE_AUTO_REASON.BLIND_DESCENT]: "Arrived hot with no trend yet — easing the current down.",
  [CHARGE_AUTO_REASON.HARD_CEILING]: "At the temperature limit — reducing the current.",
  [CHARGE_AUTO_REASON.CLOSING]: "Heating towards the limit — reducing the current.",
  [CHARGE_AUTO_REASON.CLEAR]: "Plenty of thermal room — giving current back.",
  [CHARGE_AUTO_REASON.SETTLED]: "Holding — this current keeps the pack where it should be.",
  [CHARGE_AUTO_REASON.NEAR_CEILING]: "Near the limit — holding this current steady, not raising it.",
  [CHARGE_AUTO_REASON.AT_FLOOR]: `At the ${MIN_COMMAND_A} A floor — going lower would be slower than not acting.`,
};
