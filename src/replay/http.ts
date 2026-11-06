import type { IncomingMessage, ServerResponse } from "node:http";
import { hubCandidatesReply } from "../http/settings.ts";
import { chargeAutoReply } from "../http/charge-auto.ts";
import { vcuReadReply, type VcuReadEndpointOptions } from "../http/vcu-read.ts";
import { vcuProbeReply } from "../http/vcu-probe.ts";
import { vcuWriteReply, type VcuWriteEndpointOptions } from "../http/vcu-write.ts";
import { lifetimeReadReply } from "../http/lifetime-read.ts";
import { freezeFrameReadReply } from "../http/freeze-frame-read.ts";
import { expectedFaultsReply } from "../http/expected-faults.ts";
import { waypointReply } from "../http/waypoint.ts";
import { loadExpectedFaults } from "../vcu/expected-faults.ts";
import type { ChargeAutomatic } from "../charge/auto.ts";
import type { SettingsActionReply } from "../settings/view.ts";
import type { UpdateReply } from "../http/update.ts";
import type { CanRestartReply } from "../http/can-restart.ts";
import type { RecordingFlushReply } from "../http/recording-flush.ts";

export async function refuseSimulatorAction(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: SimulatorHttpContext
): Promise<boolean> {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const kind = ROUTE_BUILDERS.get(url.pathname) ?? "generic";
  const reply = await BUILDERS[kind](context, url);
  response.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(reply));
  return true;
}

export const SIMULATOR_MESSAGE = "Disabled in the simulator: nothing is sent to a bike";

// All router literals are pinned by check-simulator. Generic entries are deliberate, including the absent fan.
export const SIMULATOR_REPLY_ROUTES = {
  "/settings": "action",
  "/settings/apply": "action",
  "/settings/hub": "action",
  "/settings/hub-candidates": "candidates",
  "/recording/flush": "action",
  "/dl": "generic",
  "/waypoint": "waypoint",
  "/status": "generic",
  "/can-restart": "action",
  "/update": "action",
  "/release-health": "generic",
  "/os-update-ready": "generic",
  "/update/reserve-stop": "generic",
  "/update-status": "generic",
  "/fan": "generic",
  "/charge-auto": "charge",
  "/dtc-table": "generic",
  "/fault-infokeys": "generic",
  "/stored-dtcs": "generic",
  "/vcu-params": "generic",
  "/lifetime-stats": "generic",
  "/lifetime-read": "lifetime",
  "/freeze-frames": "generic",
  "/freeze-frame-read": "freeze",
  "/expected-faults": "expected",
  "/vcu-read": "read",
  "/vcu-probe": "probe",
  "/vcu-write": "write",
  "/vcu-backup.csv": "generic",
} as const;

export interface SimulatorHttpContext {
  read: VcuReadEndpointOptions;
  write: VcuWriteEndpointOptions;
  automatic: ChargeAutomatic;
}

type ReplyKind = (typeof SIMULATOR_REPLY_ROUTES)[keyof typeof SIMULATOR_REPLY_ROUTES];
const ROUTE_BUILDERS = new Map<string, ReplyKind>(Object.entries(SIMULATOR_REPLY_ROUTES));

const BUILDERS = {
  action: actionFailure,
  candidates: () => hubCandidatesReply([], SIMULATOR_MESSAGE, false),
  read: (context: SimulatorHttpContext) => vcuReadReply(context.read, SIMULATOR_MESSAGE),
  probe: (context: SimulatorHttpContext) => vcuProbeReply(context.read, null, SIMULATOR_MESSAGE),
  write: (context: SimulatorHttpContext, url: URL) =>
    vcuWriteReply(
      context.write,
      url,
      null,
      SIMULATOR_MESSAGE,
      url.searchParams.get("action") === "charge-current" ? "not-sent" : undefined
    ),
  lifetime: (context: SimulatorHttpContext) => lifetimeReadReply(context.read, { message: SIMULATOR_MESSAGE }),
  freeze: (context: SimulatorHttpContext) => freezeFrameReadReply(context.read, { message: SIMULATOR_MESSAGE }),
  charge: (context: SimulatorHttpContext) => chargeAutoReply(context.automatic.state(), SIMULATOR_MESSAGE),
  expected: async (context: SimulatorHttpContext) =>
    expectedFaultsReply(await loadExpectedFaults(context.read.directory), SIMULATOR_MESSAGE),
  waypoint: () => waypointReply({ saved: false, message: SIMULATOR_MESSAGE }),
  generic: (): SimulatorGenericReply => ({ ok: false, message: SIMULATOR_MESSAGE, reason: SIMULATOR_MESSAGE }),
} satisfies Record<ReplyKind, (context: SimulatorHttpContext, url: URL) => unknown>;

function actionFailure(): UpdateReply & CanRestartReply & RecordingFlushReply & SettingsActionReply {
  return { ok: false, message: SIMULATOR_MESSAGE };
}

interface SimulatorGenericReply {
  ok: false;
  message: string;
  reason: string;
}
