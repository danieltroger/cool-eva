import assert from "assert/strict";
import ts from "typescript";
import { readFile, readdir } from "fs/promises";
import { join, dirname, normalize } from "path";
import { isRuntimeSourcePath } from "./release/files.ts";
import { handleRecordingFlushEndpoint } from "../src/http/recording-flush.ts";
import { postRequest, recordingResponse } from "./recording-response.ts";
import { configureGpsClock, syncSystemClockFromGps, systemClockTrust } from "../src/gps/clock.ts";
import { REQUIRED_CONSISTENT_READINGS } from "../src/gps/clock-gate.ts";

await checkLegacySurfaces();
await checkBundledRuntime();
await checkClockSeams();
await checkRecordingFlush();
console.log("settings cutover checks passed");

async function checkLegacySurfaces(): Promise<void> {
  const legacy =
    /\b(?:COOLANT_ENABLED|FAN_ENABLED|CAN_ENABLED|OBD_ENABLED|ELOCK_ENABLED|WIFI_ENABLED|WIFI_IFACE|WIFI_HOTSPOT_SSID|BLE_ENABLED|BLE_MAC|BLE_SECRET|GPS_TIME_SYNC|CUSTOM_BMS_CONFIG|RIDE_LOG_PUBKEY|RIDE_LOG_DIR|VCU_PARAM_DIR|SERVICE_MODE_ENABLED|SERVICE_WRITE_ENABLED|UPDATE_DIR|CHARGE_AUTO_ENABLED)\b/;
  const failures: string[] = [];
  for (const directory of ["src", "public"]) {
    for (const entry of await readdir(directory, { recursive: true })) {
      if (!/\.(ts|js)$/.test(entry) || entry.startsWith("vendor/") || entry === "settings/legacy.ts") continue;
      const path = join(directory, entry);
      const source = ts.createSourceFile(path, await readFile(path, "utf-8"), ts.ScriptTarget.ESNext, true);
      scanLiterals(source, source, path, legacy, failures);
    }
  }
  assert.deepEqual(
    failures,
    [],
    "Legacy instructions belong only in the importer. Comments are excluded; touched blocks follow CLAUDE.md."
  );
  const installer = await readFile("scripts/setup-service.ts", "utf-8");
  assert.equal(installer.includes("readEnvFile"), false);
  assert.equal(installer.includes("EnvironmentFile="), false);
  assert.ok(installer.indexOf("await migrateBeforeReplacingUnit()") < installer.indexOf("await writeFile(servicePath"));
  const index = await readFile("src/index.ts", "utf-8");
  assert.ok(index.indexOf("await startSettings(") < index.indexOf("await initEncryptedLog("));
  assert.ok(index.includes("handleUpdateEndpoint(req, res, UPDATE_DIR, settingsHttp)"));
  assert.ok(index.includes('req.headers["x-cool-eva"]'));
  const waypoint = await readFile("public/lib/waypoint.js", "utf-8");
  assert.ok(waypoint.includes('method: "POST"') && waypoint.includes('"X-Cool-Eva": "waypoint"'));
  const client = await readFile("src/ble/client.ts", "utf-8");
  const requests = client.slice(
    client.indexOf('console.warn("ble: telemetry request failed:'),
    client.indexOf("}, TELEMETRY_REQUEST_INTERVAL_MS)")
  );
  assert.equal(
    requests.includes("options.onState"),
    false,
    "A successful telemetry request must leave the hub Connected."
  );
  assert.match(
    client,
    /finally \{\s+options\.onState\?\.\(stopped \? "Off" : "Unavailable[^\n]+\n\s+clearInterval\(requestTimer\)/,
    "Hub unavailability follows session cleanup, rather than each successful request."
  );
  console.log(
    "  all 20 legacy names are absent from executable instructions; startup precedes writers; unit replacement follows migration; waypoint has a CSRF header"
  );
}

async function checkBundledRuntime(): Promise<void> {
  const outsideBundle: string[] = [];
  for (const entry of await readdir("src", { recursive: true })) {
    if (!entry.endsWith(".ts")) continue;
    const path = join("src", entry);
    const source = ts.createSourceFile(path, await readFile(path, "utf-8"), ts.ScriptTarget.ESNext, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = statement.moduleSpecifier.text;
      if (target.startsWith(".") && !isRuntimeSourcePath(normalize(join(dirname(path), target)))) {
        outsideBundle.push(`${path}: ${target}`);
      }
    }
  }
  assert.deepEqual(outsideBundle, [], "Every service import must be present in #324's runtime bundle.");
  assert.ok(isRuntimeSourcePath("src/storage/capture-pruner.sh"));
  console.log(
    "  runtime imports and the migration pruner ship in the release bundle; no app dependency on installer scripts"
  );
}

function scanLiterals(node: ts.Node, source: ts.SourceFile, path: string, legacy: RegExp, failures: string[]): void {
  if (
    ts.isStringLiteralLike(node) ||
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail
  ) {
    if (legacy.test((node as ts.StringLiteralLike).text)) {
      failures.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
  }
  ts.forEachChild(node, child => scanLiterals(child, source, path, legacy, failures));
}

async function checkClockSeams(): Promise<void> {
  let monotonic = 1_000;
  let wall = Date.UTC(2027, 0, 1) / 1_000;
  const commands: [string, string[]][] = [];
  configureGpsClock({
    wallTimeSeconds: () => wall,
    now: () => monotonic,
    userId: () => 0,
    run: async (command, arguments_) => {
      commands.push([command, arguments_]);
    },
  });
  assert.equal(systemClockTrust(), "never-synced");
  for (let count = 0; count < REQUIRED_CONSISTENT_READINGS + 1; count += 1) {
    await syncSystemClockFromGps(wall + 7_200);
    monotonic += 1_000;
    wall += 1;
  }
  assert.ok(commands.length > 0);
  assert.equal(commands[0][0], "date");
  assert.deepEqual(commands[0][1].slice(0, 2), ["-u", "-s"]);
  assert.equal(systemClockTrust(), "satellite-backed");
  configureGpsClock({
    externalClock: true,
    run: async () => {
      throw new Error("External replay clock must not spawn date");
    },
  });
  await syncSystemClockFromGps(wall + 20_000);
  console.log(
    "  GPS time discipline uses injected wall/monotonic/uid/command seams; no check can set this host's clock"
  );
}

async function checkRecordingFlush(): Promise<void> {
  let flushed = 0;
  const flush = async () => {
    flushed += 1;
  };
  const refused = recordingResponse();
  await handleRecordingFlushEndpoint(postRequest(), refused.res, flush);
  assert.equal(refused.statusCode, 403);
  assert.equal(flushed, 0);
  const allowed = recordingResponse();
  await handleRecordingFlushEndpoint(
    postRequest({ "x-cool-eva": "recording", "content-type": "application/json" }),
    allowed.res,
    flush
  );
  assert.equal(allowed.statusCode, 200);
  assert.equal(flushed, 1);
  console.log("  sealing is a protected POST; the GET download no longer causes a disk write");
}
