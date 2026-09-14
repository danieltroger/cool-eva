import type { IncomingMessage, ServerResponse } from "node:http";
import { isValidFaultKey, loadExpectedFaults, setExpectedFault, type ExpectedFaults } from "../vcu/expected-faults.ts";

// GET /expected-faults — which codes the owner has marked as expected.
// POST /expected-faults?component=34&symptom=1&expected=1 — mark one, or unmark it.
//
// ⚠️ IT NEVER TOUCHES THE BUS. This is a file on the Pi and a rendering preference: an
// expected code is still read, still counted and still shown with its values. So there is
// no service gate and no arming here — those guard transmitting to a motorcycle, and
// spending them on a checkbox would teach people to tap through them.
//
// ⚠️ A POST WITH QUERY PARAMETERS, not a body. No handler in src/http/ reads a request body
// and this is not the place to introduce the first one for a two-field write; /vcu-write,
// /fan, /charge-auto and /vcu-probe all take `url.searchParams`. It still carries an
// `X-Cool-Eva` header, per this repo's own convention, so a CORS-simple request cannot
// rewrite the list.

export const EXPECTED_FAULTS_HEADER = "x-cool-eva";
export const EXPECTED_FAULTS_HEADER_VALUE = "expected-faults";

export interface ExpectedFaultsResponse {
  /** The list as it now stands, always — so a client never has to re-fetch after a write. */
  expected: ExpectedFaults;
  /** Why a request was refused, or null. */
  message: string | null;
}

export async function handleExpectedFaultsEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  directory: string
): Promise<void> {
  if (req.method === "GET") {
    respond(res, 200, await loadExpectedFaults(directory), null);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, POST" });
    res.end("use GET to read the expected-fault list and POST to change it\n");
    return;
  }
  if (req.headers[EXPECTED_FAULTS_HEADER] !== EXPECTED_FAULTS_HEADER_VALUE) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`changing the list needs the ${EXPECTED_FAULTS_HEADER}: ${EXPECTED_FAULTS_HEADER_VALUE} header\n`);
    return;
  }

  const component = Number(url.searchParams.get("component"));
  const symptom = Number(url.searchParams.get("symptom"));
  if (!isValidFaultKey(component, symptom)) {
    // Refused rather than clamped, and the current list still comes back so a client that
    // sent nonsense is not left guessing what the Pi now holds.
    respond(
      res,
      400,
      await loadExpectedFaults(directory),
      `component and symptom must name a code this bike could report — got ${url.searchParams.get("component")}/${url.searchParams.get("symptom")}`
    );
    return;
  }
  const raw = url.searchParams.get("expected");
  if (raw !== "0" && raw !== "1") {
    respond(res, 400, await loadExpectedFaults(directory), `expected must be 0 or 1 — got ${JSON.stringify(raw)}`);
    return;
  }
  respond(res, 200, await setExpectedFault(directory, { component, symptom }, raw === "1"), null);
}

function respond(res: ServerResponse, statusCode: number, expected: ExpectedFaults, message: string | null): void {
  const payload: ExpectedFaultsResponse = { expected, message };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
