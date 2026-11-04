import type { IncomingMessage, ServerResponse } from "http";
import { readSettingsBody } from "./settings.ts";
import { csrfRefusal } from "./mutation-guard.ts";
import type { WifiNetworks } from "../wifi/networks.ts";
import {
  NetworkRefusal,
  type NetworkDraft,
  type NetworkProof,
  type NetworkRequestIdentity,
} from "../wifi/network-types.ts";

export async function handleNetworksEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  runtime: NetworksHttpRuntime
): Promise<void> {
  try {
    const networks = runtime.controller;
    if (path === "/settings/networks" && req.method === "GET") {
      if (!networks) {
        respond(res, 503, { ok: false, message: runtime.fault });
        return;
      }
      respond(res, 200, await networks.view(networkRequestProof(req)));
      return;
    }
    if (req.method !== "POST") {
      respond(res, 405, { ok: false, message: "Use POST for this network action." });
      return;
    }
    if (
      req.headers["x-cool-eva"] !== "settings" ||
      !/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))
    ) {
      respond(res, 403, csrfRefusal("Reload the page before changing networks."));
      return;
    }
    if (!networks) {
      throw new NetworkRefusal(runtime.fault);
    }
    const raw = await readSettingsBody(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new NetworkRefusal("Read the network state before changing it.");
    }
    const body = raw as Record<string, unknown>;
    const fields = [
      "instanceId",
      "generation",
      "revision",
      "settingsRevision",
      ...(path === "/settings/networks/save" ? ["draft"] : []),
    ];
    if (
      Object.keys(body).some(key => !fields.includes(key)) ||
      typeof body.instanceId !== "string" ||
      typeof body.generation !== "string" ||
      !Number.isSafeInteger(body.revision) ||
      !(body.settingsRevision === null || Number.isSafeInteger(body.settingsRevision))
    ) {
      throw new NetworkRefusal("Read the current network state before changing it.");
    }
    const identity = body as unknown as NetworkRequestIdentity;
    const proof = networkRequestProof(req);
    switch (path) {
      case "/settings/networks/save": {
        const draft = body.draft;
        if (
          !draft ||
          typeof draft !== "object" ||
          Array.isArray(draft) ||
          Object.keys(draft).some(
            key =>
              ![
                "ssid",
                "purpose",
                "replacedUuid",
                "passwordMode",
                "password",
                "hidden",
                "accessPointChange",
                "bluetoothTested",
              ].includes(key)
          )
        ) {
          throw new NetworkRefusal("Enter the network details in this dashboard.");
        }
        await networks.save(identity, draft as NetworkDraft, proof.tunnel);
        break;
      }
      case "/settings/networks/trial":
        await networks.trial(identity);
        break;
      case "/settings/networks/keep":
        await networks.keep(identity, proof);
        break;
      case "/settings/networks/previous":
        await networks.previous(identity);
        break;
      case "/settings/networks/cancel":
        await networks.cancel(identity);
        break;
      case "/settings/networks/maintenance":
        await networks.maintenance(identity);
        break;
      case "/settings/networks/scan":
        respond(res, 200, { ok: true, names: await networks.scan(identity) });
        return;
      default:
        respond(res, 404, { ok: false, message: "This network action is not available." });
        return;
    }
    respond(res, 200, await networks.view(proof));
  } catch (error) {
    console.warn("wifi-settings: HTTP action refused or unconfirmed; no submitted values logged");
    respond(res, 409, {
      ok: false,
      message:
        error instanceof NetworkRefusal
          ? error.message
          : "The network action could not be confirmed. Reconnect and read this Pi before trying again.",
    });
  }
}

export interface NetworksHttpRuntime {
  controller: WifiNetworks | null;
  fault: string;
}

export function networkRequestProof(req: IncomingMessage): NetworkProof {
  const remoteAddress = req.socket.remoteAddress ?? "";
  return {
    localAddress: req.socket.localAddress ?? "",
    remoteAddress,
    tunnel:
      req.headers["x-cool-eva-tunnel"] === "1" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress),
  };
}
function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
