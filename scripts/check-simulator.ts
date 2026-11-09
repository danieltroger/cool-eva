import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { parseCaptureFrame, replayCapture } from "../src/replay/source.ts";
import { matchesReceiveFilter } from "../src/can/receive.ts";
import { SIMULATOR_MESSAGE, SIMULATOR_REPLY_ROUTES } from "../src/replay/http.ts";
import { replayOptions } from "../src/replay/runtime.ts";
import { captureLine, routedPaths, writeSimulatorCapture } from "./simulator-fixture.ts";
import { runSimulator, type SimulatorPass } from "./simulate.ts";
import type { DashboardMessage } from "../src/ws.ts";
import type { SettingsReply } from "../src/settings/view.ts";
import { monotonicNow } from "../src/monotonic.ts";
import { setTimeout as delay } from "node:timers/promises";

export async function checkSimulator(): Promise<void> {
  await checkTiming();
  await checkRouteTable();
  await checkNothingEscapes();
  await checkScratchMutation();
  console.log(
    "✓ simulator: real server, source timing/filter, all HTTP refusals, scratch/PID/port isolation and no escaped hardware I/O"
  );
}

async function checkTiming(): Promise<void> {
  const frame = parseCaptureFrame(captureLine(0));
  assert(frame);
  assert.equal(frame.captureTime, Date.UTC(2026, 0, 1));
  assert.equal(parseCaptureFrame(captureLine(0).replace("2026-01-01", "2026-02-31")), null);
  assert.equal(parseCaptureFrame("(1.234) can0 104#0000000000000000"), null);
  assert.equal(parseCaptureFrame(captureLine(0).replace("[8]", "[7]")), null);
  assert.equal(parseCaptureFrame(captureLine(0).replace("00 00", "GG 00")), null);
  assert.equal(matchesReceiveFilter({ id: 0x7df, data: Buffer.alloc(8) }), false);
  assert.equal(matchesReceiveFilter({ id: 0x7e8, data: Buffer.alloc(8) }), true);
  assert.equal(matchesReceiveFilter({ id: 0x104, data: Buffer.alloc(8), rtr: true }), false);
  assert.throws(() => replayOptions(["--replay", "/tmp/file.zst", "/tmp/synthetic", "1", "0"]), /Decompress/);
  assert.throws(() => replayOptions(["--replay", "relative.log", "/tmp/synthetic", "1", "0"]), /absolute/);
  const savedNow = Date.now;
  let now = 0;
  const received: number[] = [];
  const times = [0, 150, 149.5, 4_224, 3_000, 3_150, 60_000, 60_150];
  try {
    await replayCapture({
      path: "synthetic",
      lines: linesOf(times.map(time => captureLine(time))),
      signal: new AbortController().signal,
      clock: {
        now: () => now,
        wait: async milliseconds => {
          now += milliseconds;
          Date.now = () => savedNow() - 86_400_000;
        },
      },
      progress: () => {},
      receive: () => {
        received.push(now);
      },
    });
  } finally {
    Date.now = savedNow;
  }
  assert.deepEqual(received, [0, 150, 150, 4_224, 4_224, 4_374, 4_374, 4_524]);
  assert.equal(parseCaptureFrame(captureLine(86_400_100))!.captureTime - frame.captureTime, 86_400_100);
  const cancellation = new AbortController();
  await assert.rejects(
    replayCapture({
      path: "synthetic",
      lines: linesOf([captureLine(0), captureLine(1_000)]),
      signal: cancellation.signal,
      clock: {
        now: () => 0,
        wait: async () => {
          cancellation.abort();
          cancellation.signal.throwIfAborted();
        },
      },
      receive: () => {},
      progress: () => {},
    }),
    /abort/i
  );
  await assert.rejects(
    replayCapture({
      path: "synthetic",
      lines: linesOf(["partial"]),
      signal: new AbortController().signal,
      receive: () => {},
      progress: () => {},
    }),
    /no recognised/
  );
}

async function* linesOf(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

async function checkRouteTable(): Promise<void> {
  const entry = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const settings = await readFile(new URL("../src/http/settings.ts", import.meta.url), "utf8");
  assert.deepEqual(
    Object.keys(SIMULATOR_REPLY_ROUTES).sort(),
    [...new Set([...routedPaths(entry), ...routedPaths(settings, "path")])].sort()
  );
  assert(entry.indexOf("await refuseSimulatorAction(") < entry.indexOf('url.pathname === "/settings"'));
}

async function checkScratchMutation(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-simulator-hash-"));
  const path = join(directory, "synthetic.log");
  await writeFile(path, captureLine(0));
  try {
    await assert.rejects(
      runSimulator({
        path,
        port: 0,
        onOutput: () => {},
        onReady: async pass => {
          await writeFile(join(pass.root, "unexpected-state"), "synthetic mutation");
        },
      }),
      /scratch contents changed/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkNothingEscapes(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-simulator-proof-"));
  const capture = join(directory, "synthetic.log");
  const audit = join(directory, "audit.jsonl");
  await writeSimulatorCapture(capture);
  await writeFile(audit, "");
  const originalAudit = process.env.COOL_EVA_SIMULATOR_FENCE_LOG;
  process.env.COOL_EVA_SIMULATOR_FENCE_LOG = audit;
  const cancellation = new AbortController();
  const snapshots: Record<string, number> = {};
  const passes: SimulatorPass[] = [];
  const sockets: WebSocket[] = [];
  let output = "";
  let settingsInstance: string | null = null;
  let startedAt = 0;
  let duringPass = Promise.resolve();
  let duringPassError: unknown;
  const timeout = setTimeout(() => cancellation.abort(new Error("Simulator proof timed out")), 30_000);
  try {
    await runSimulator({
      path: capture,
      port: 0,
      signal: cancellation.signal,
      preload: fileURLToPath(new URL("./simulator-preload.mjs", import.meta.url)),
      onOutput: text => {
        output += text;
      },
      onReady: async pass => {
        passes.push(pass);
        const base = `http://127.0.0.1:${pass.port}`;
        const settings = (await (await fetch(base + "/settings")).json()) as SettingsReply;
        assert.equal(settings.active.automaticDcChargingEnabled, false);
        assert.equal(settings.active.customBmsConfigurationFlashed, true);
        if (settingsInstance !== null) assert.equal(settings.instanceId, settingsInstance);
        settingsInstance = settings.instanceId;
        if (pass.pass === 2) {
          await duringPass;
          if (duringPassError) throw duringPassError;
          assert.notEqual(pass.pid, passes[0].pid);
          assert.equal(pass.port, passes[0].port);
          assert.equal(snapshots.ambient_temp, 21);
          assert.equal(snapshots.batt_temp_lo, 23);
          assert.equal(snapshots.batt_temp_hi, 27);
          assert(monotonicNow() - startedAt > 5_000);
          await checkWaypointCounters(base);
          await assertPreviousHoldersGone(audit, passes[0].pid);
          cancellation.abort();
          return;
        }
        startedAt = monotonicNow();
        const socket = new WebSocket(`ws://127.0.0.1:${pass.port}`);
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.on("message", data => {
            const message = JSON.parse(String(data)) as DashboardMessage;
            for (const [key, reading] of Object.entries(message.signals)) snapshots[key] = reading.value;
            if (message.type === "snapshot") resolve();
          });
        });
        assert.equal(snapshots.ambient_temp, undefined);
        await checkHttpRefusals(base);
        duringPass = delay(7_000)
          .then(() => checkWaypointCounters(base))
          .catch(error => {
            duringPassError = error;
          });
      },
    });
    assert.equal(passes.length, 2, output);
    const escaped = output.split("\n").filter(line => /clock: .*off GPS|Simulator proof blocked/.test(line));
    assert.deepEqual(escaped, [], "No clock or hardware escape witness");
    const events = await auditEvents(audit);
    assert.deepEqual(
      events.filter(event => String(event.type).startsWith("denied")),
      [],
      output
    );
    assert(
      events.some(event => event.command === "git" && JSON.stringify(event.arguments).includes("rev-parse")),
      "ESM execFile interception observed git identity"
    );
    assert(
      events.some(event => event.command === "git" && JSON.stringify(event.arguments).includes("--porcelain")),
      "ESM execFile interception observed git status"
    );
    await assertPreviousHoldersGone(audit);
    await assert.rejects(readFile(join(passes[0].root, "state/settings.json")), /ENOENT/);
  } catch (error) {
    console.error(
      output
        .split("\n")
        .filter(line => /clock: .*off GPS|Simulator proof blocked/.test(line))
        .join("\n")
    );
    throw error;
  } finally {
    clearTimeout(timeout);
    for (const socket of sockets) socket.terminate();
    if (originalAudit === undefined) delete process.env.COOL_EVA_SIMULATOR_FENCE_LOG;
    else process.env.COOL_EVA_SIMULATOR_FENCE_LOG = originalAudit;
    await rm(directory, { recursive: true, force: true });
  }
}

export async function checkHttpRefusals(base: string): Promise<void> {
  const catalogueResponse = await fetch(base + "/service-catalogue");
  assert.equal(catalogueResponse.status, 200);
  const catalogue = (await catalogueResponse.json()) as import("../src/http/service-catalogue.ts").ServiceCatalogue;
  assert.ok(catalogue.parameters.some(parameter => parameter.name === "TORQUE_LIMIT" && parameter.scale === 0.1));
  assert.ok(catalogue.signals.some(signal => signal.key === "coolant_in" && signal.unit === "°C"));
  const restart = await fetch(base + "/can-restart", {
    method: "POST",
    headers: {
      "X-Cool-Eva": "can-restart",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const restartReply = await restart.text();
  assert.equal(restart.status, 403, `A removed simulator fence reaches the real ip attempt: ${restartReply}`);
  const entry = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  for (const path of routedPaths(entry)) {
    const response = await fetch(base + path);
    assert(response.status < 600, `GET ${path}`);
    await response.arrayBuffer();
  }
  for (const path of [...Object.keys(SIMULATOR_REPLY_ROUTES), "/future-action"]) {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const response = await fetch(base + path, {
        method,
        headers: { "X-Cool-Eva": endpointHeader(path), "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 0, changes: {}, expectedGeneration: "synthetic" }),
      });
      assert.equal(response.status, 403, `${method} ${path}`);
      const reply = (await response.json()) as Record<string, unknown>;
      assert.equal(reply.message, SIMULATOR_MESSAGE, `${method} ${path}`);
      assert.equal(reply.csrfRefusal, undefined);
      if (
        SIMULATOR_REPLY_ROUTES[path as keyof typeof SIMULATOR_REPLY_ROUTES] !== "generic" &&
        path !== "/future-action"
      )
        assert.equal(reply.reason, undefined);
      if (path === "/lifetime-read") assert.equal(reply.answered, null);
      if (path === "/waypoint") assert.equal(reply.saved, false);
      if (path === "/vcu-read") assert(reply.run && reply.gate && reply.export);
      if (path === "/charge-auto") assert(reply.state);
    }
  }
  await checkWaypointCounters(base);
}

function endpointHeader(path: string): string {
  if (path.startsWith("/settings")) return "settings";
  if (["/vcu-read", "/vcu-probe", "/lifetime-read", "/freeze-frame-read"].includes(path)) return "service-mode";
  if (path === "/vcu-write") return "service-write";
  if (path === "/recording/flush") return "recording";
  return path.slice(1);
}

async function checkWaypointCounters(base: string): Promise<void> {
  const status = (await (await fetch(base + "/status")).json()) as { waypoints: number; waypointsRefused: number };
  assert.equal(status.waypoints, 0);
  assert.equal(status.waypointsRefused, 0);
}

interface AuditEvent {
  type: string;
  pid: number;
  holderPid?: number;
  command?: string;
  arguments?: string[];
}

async function auditEvents(path: string): Promise<AuditEvent[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as AuditEvent);
}

async function assertPreviousHoldersGone(path: string, parentPid?: number): Promise<void> {
  const holders = (await auditEvents(path)).filter(
    event => event.type === "holder" && (parentPid === undefined || event.pid === parentPid)
  );
  assert(holders.length > 0, "Lock-holder positive control observed");
  for (const holder of holders) {
    assert.throws(() => process.kill(holder.holderPid!, 0), /ESRCH/, "Previous pass left no lock-holder orphan");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkSimulator();
}
