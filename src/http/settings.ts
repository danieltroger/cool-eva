import { createHash, createPublicKey } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { validBleSecret } from "../../public/lib/ble-secret.js";
import { bluetoothCodeId, type SettingsRuntime } from "../settings/startup.ts";
import { pendingSettings, record } from "../settings/schema.ts";
import { validateSettingsPatch } from "../settings/validation.ts";
import { publicSettings, type SettingsReply, type HubCandidate } from "../settings/view.ts";
import type { SettingsRestart } from "../settings/restart.ts";
import { retiredLegacyChoices } from "../settings/legacy.ts";

export async function handleSettingsEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: SettingsHttpContext
): Promise<void> {
  try {
    if (path === "/settings" && req.method === "GET") {
      respond(res, 200, settingsReply(context));
      return;
    }
    const allowed = path === "/settings" ? "PATCH" : "POST";
    if (req.method !== allowed) {
      respond(res, 405, { ok: false, message: `Use ${allowed} for this action.` });
      return;
    }
    if (
      req.headers["x-cool-eva"] !== "settings" ||
      !/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))
    ) {
      respond(res, 403, { ok: false, message: "Reload the page before changing settings." });
      return;
    }
    const body = record(await readSettingsBody(req), "request");
    const fields =
      path === "/settings"
        ? ["revision", "changes"]
        : path === "/settings/hub"
          ? ["revision", "address"]
          : path === "/settings/apply"
            ? ["expectedGeneration", "revision", "bluetoothCodeId"]
            : [];
    if (Object.keys(body).some(key => !fields.includes(key))) {
      throw new Error("This request contains an unsupported field.");
    }
    if (path === "/settings/hub-candidates") {
      const candidates = await context.scanHubs();
      respond(res, 200, {
        ok: true,
        message: candidates.length
          ? "Choose your motorcycle. Other motorcycles may be nearby."
          : "No motorcycle found. Wake the bike and try again.",
        candidates,
      });
      return;
    }
    if (path === "/settings/apply") {
      const fromBluetooth =
        req.headers["x-cool-eva-tunnel"] === "1" &&
        (req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1");
      const reserved = await reserveSettingsRestart(req, body, context);
      let finished: () => void = () => {};
      const delivery = new Promise<void>(resolve => {
        finished = resolve;
      });
      res.once("finish", finished);
      res.once("close", finished);
      respond(res, 200, {
        ok: true,
        message: reserved
          ? "Restart requested. Reconnect to confirm the active settings."
          : "Read back the current process before another restart.",
        settings: settingsReply(context),
      });
      if (reserved) {
        void context.restart.deliverAndSchedule(async () => {
          await delivery;
          if (fromBluetooth) {
            await context.drainBluetooth();
          }
        });
      }
      return;
    }
    if (!Number.isSafeInteger(body.revision)) {
      throw new Error("Reload settings before saving.");
    }
    if (path === "/settings/hub") {
      if (
        body.address !== null &&
        (typeof body.address !== "string" || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(body.address))
      ) {
        throw new Error("Choose a motorcycle from the discovery list.");
      }
      await context.runtime.store.update(Number(body.revision), {
        hubAddress: body.address === null ? null : String(body.address),
        discoverHubOnce: false,
      });
    } else if (path === "/settings") {
      const changes = await validateSettingsPatch(body.changes, context.runtime.paths, context.codeDirectory);
      if (changes.dashboardBluetoothSecret && !validBleSecret(changes.dashboardBluetoothSecret)) {
        throw new Error("Use a generated Bluetooth key.");
      }
      await context.runtime.store.update(Number(body.revision), changes);
    } else {
      respond(res, 404, { ok: false, message: "This settings action is not available." });
      return;
    }
    respond(res, 200, { ok: true, message: "Saved. Applies after restart.", settings: settingsReply(context) });
  } catch (error) {
    // JSON parse errors may quote the submitted credential. They must never reach logs or the reply.
    const message =
      error instanceof SyntaxError
        ? "The request is not valid JSON."
        : error instanceof Error
          ? error.message
          : "Settings could not be changed.";
    console.warn("settings: request refused", error instanceof SyntaxError ? "invalid JSON" : message);
    respond(res, 409, { ok: false, message });
  }
}

export interface SettingsHttpContext {
  version?: string;
  runtime: SettingsRuntime;
  restart: SettingsRestart;
  codeDirectory: string;
  scanHubs: () => Promise<HubCandidate[]>;
  drainBluetooth: () => Promise<void>;
  activeHubAddress?: () => string | null;
  readiness?: () => SettingsReply["readiness"];
}

export function settingsReply(context: SettingsHttpContext): SettingsReply {
  const { runtime, restart } = context;
  const state = runtime.store.read();
  const document = state.kind === "ready" ? state.document : null;
  const saved = document?.values ?? runtime.active;
  const learned = document?.learned.hubAddress ?? null;
  const activeChoices = runtime.recordingKeyBeforePause
    ? { ...runtime.active, rideLogPublicKeyPem: runtime.recordingKeyBeforePause }
    : runtime.active;
  return {
    ok: state.kind === "ready",
    source: document?.migration.source ?? "unavailable",
    version: context.version ?? "Unknown",
    recordingFingerprint: activeChoices.rideLogPublicKeyPem
      ? createHash("sha256")
          .update(createPublicKey(activeChoices.rideLogPublicKeyPem).export({ type: "spki", format: "der" }))
          .digest("hex")
      : null,
    instanceId: state.kind === "ready" && typeof state.raw.instanceId === "string" ? state.raw.instanceId : null,
    processGeneration: restart.generation,
    revision: document?.revision ?? null,
    saved: publicSettings(saved, state.kind === "ready" ? bluetoothCodeId(state.raw) : null, learned),
    active: publicSettings(activeChoices, runtime.activeCodeId, context.activeHubAddress?.() ?? learned),
    pending: document ? pendingSettings(saved, activeChoices) : [],
    fault: state.kind === "degraded" ? state.message : runtime.fault,
    notices: document?.migration.notices ?? [],
    retiredChoices: retiredLegacyChoices(document?.migration.notices ?? []),
    readiness: { ...(context.readiness?.() ?? runtime.readiness) },
    restart: restart.status(),
    locations: {
      root: runtime.paths.dataRoot,
      wifi: runtime.wifiDiagnosticDirectory,
      captures: runtime.paths.captureDirectory,
    },
  };
}

export async function readSettingsBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += bytes.length;
    if (length > 16 * 1024) {
      throw new Error("The settings request is too large.");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch (error) {
    console.warn("settings: invalid request JSON", error instanceof Error ? error.name : "unknown error");
    throw new Error("The request is not valid JSON.");
  }
}

export async function reserveSettingsRestart(
  req: IncomingMessage,
  body: Record<string, unknown>,
  context: SettingsHttpContext
): Promise<boolean> {
  if (typeof body.expectedGeneration !== "string" || (body.revision !== null && !Number.isSafeInteger(body.revision))) {
    throw new Error("Reload settings before restarting.");
  }
  if (body.expectedGeneration !== context.restart.generation) return false;
  const view = settingsReply(context);
  const fromBluetooth =
    req.headers["x-cool-eva-tunnel"] === "1" && ["127.0.0.1", "::1"].includes(req.socket.remoteAddress ?? "");
  if (
    fromBluetooth &&
    view.saved.bluetoothCodeId !== view.active.bluetoothCodeId &&
    (!view.saved.bluetoothCodeId || body.bluetoothCodeId !== view.saved.bluetoothCodeId)
  ) {
    throw new Error("Save this Pi’s pending Bluetooth key on this phone, or reconnect over Wi-Fi, before restarting.");
  }
  return context.restart.reserve(body.expectedGeneration, body.revision === null ? null : Number(body.revision));
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
