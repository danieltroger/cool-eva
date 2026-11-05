import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { handleBundleUpdate } from "../src/http/bundle-update.ts";
import { handleUpdateEndpoint } from "../src/http/update.ts";
import { handleSettingsEndpoint, settingsReply, type SettingsHttpContext } from "../src/http/settings.ts";
import { createSettingsRestart } from "../src/settings/restart.ts";
import { startSettings } from "../src/settings/startup.ts";
import type { SettingsStore } from "../src/settings/store.ts";
import { managedCodeRoot, readReleaseMetadata } from "../src/release/metadata.ts";
import { acquireBus, busHeldBy } from "../src/vcu/bus-lease.ts";
import { closeSettingsFixture, settingsFixture } from "./settings-check-fixtures.ts";
import { recordingResponse, postRequest } from "./recording-response.ts";
import { createUpdateFixture, fixtureEnvironment, REPOSITORY, type UpdateFixture } from "./update-check/fixture.ts";

export async function checkBundleAdmission(): Promise<void> {
  const parent = join(REPOSITORY, ".preview-shots");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "bundle-admission-"));
  const fixture = await settingsFixture(directory);
  const bundle = await createUpdateFixture(directory);
  const privateDirectory = join(bundle.data, "updater");
  const runtime = await startSettings({
    codeDirectory: fixture.directory,
    workingDirectory: fixture.directory,
    environment: {},
    paths: fixture.paths,
    lock: fixture.lock,
    isLegacyInstallation: async () => false,
  });
  let moving = false;
  const restart = createSettingsRestart({
    store: runtime.store,
    motionBlockers: () => (moving ? ["synthetic movement"] : []),
    schedule: async () => {
      throw new Error("Bundle admission must not schedule a second app restart");
    },
  });
  const context: SettingsHttpContext = {
    runtime,
    restart,
    codeDirectory: fixture.directory,
    scanHubs: async () => [],
    drainBluetooth: async () => {},
  };
  let queued = 0;
  const queue = async (): Promise<void> => {
    queued++;
  };
  const body = (): Record<string, unknown> => ({
    expectedGeneration: restart.generation,
    revision: settingsReply(context).revision,
  });
  const admission = (requestBody = body(), headers: Record<string, string> = {}) => ({
    reservation: { request: postRequest(headers), body: requestBody, settings: context },
    queue,
  });
  try {
    const success = recordingResponse();
    await handleBundleUpdate(success.res, privateDirectory, {
      ...admission(),
      queue: async () => {
        assert.match(busHeldBy() ?? "", /Cool Eva restart/);
        assert.equal(acquireBus("another write").ok, false);
        await assert.rejects(runtime.store.update(0, { coolantProbesEnabled: true }), /restart is reserved/);
        const duplicate = recordingResponse();
        await handleBundleUpdate(duplicate.res, privateDirectory, admission());
        assert.equal(duplicate.statusCode, 409);
        assert.equal(queued, 0);
        queued++;
      },
    });
    assert.equal(success.statusCode, 202);
    assert.equal(queued, 1);
    assert.equal(busHeldBy(), null);
    assert.equal(restart.status().state, "idle");
    assert.equal(JSON.parse(success.body).settings.processGeneration, restart.generation);
    await runtime.store.update(0, { coolantProbesEnabled: true });
    const stale = recordingResponse();
    await handleBundleUpdate(
      stale.res,
      privateDirectory,
      admission({ expectedGeneration: restart.generation, revision: 0 })
    );
    assert.equal(stale.statusCode, 409);
    assert.equal(queued, 1);

    moving = true;
    const movingReply = recordingResponse();
    await handleBundleUpdate(movingReply.res, privateDirectory, admission());
    assert.equal(movingReply.statusCode, 409);
    assert.match(movingReply.body, /parked/);
    moving = false;
    const held = acquireBus("synthetic parameter read");
    assert(held.ok);
    try {
      const busy = recordingResponse();
      await handleBundleUpdate(busy.res, privateDirectory, admission());
      assert.equal(busy.statusCode, 409);
      assert.match(busy.body, /Busy/);
    } finally {
      held.lease.release();
    }
    assert.equal(queued, 1);

    await runtime.store.update(1, { dashboardBluetoothSecret: "ab".repeat(32) });
    const tunnelRequest = postRequest({ "x-cool-eva-tunnel": "1" });
    Object.assign(tunnelRequest, { socket: { remoteAddress: "127.0.0.1" } });
    const refused = recordingResponse();
    await handleBundleUpdate(refused.res, privateDirectory, {
      reservation: { request: tunnelRequest, body: body(), settings: context },
      queue,
    });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.body, /Bluetooth key/);
    assert.equal(queued, 1);
    const accepted = recordingResponse();
    await handleBundleUpdate(accepted.res, privateDirectory, {
      reservation: {
        request: tunnelRequest,
        body: { ...body(), bluetoothCodeId: settingsReply(context).saved.bluetoothCodeId },
        settings: context,
      },
      queue,
    });
    assert.equal(accepted.statusCode, 202);
    assert.equal(queued, 2);

    const failed = recordingResponse();
    await handleBundleUpdate(failed.res, privateDirectory, {
      ...admission(),
      queue: async () => {
        throw new Error("Synthetic systemd refusal");
      },
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(busHeldBy(), null);
    assert.equal(restart.status().state, "idle");
    await runtime.store.update(2, { radiatorFanEnabled: true });
    await checkEndpointAdmission(bundle, context);

    const stopping = recordingResponse();
    await handleBundleUpdate(stopping.res, privateDirectory, {
      ...admission(),
      queue: async () => {
        restart.consume();
      },
    });
    assert.equal(stopping.statusCode, 202);
    assert.match(busHeldBy() ?? "", /Cool Eva restart/);
    await assert.rejects(runtime.store.update(3, { coolantProbesEnabled: false }), /restart is reserved/);
    await restart.close();
    assert.equal(busHeldBy(), null);
    await checkAdmissionDeadline(runtime.store);
    let currentVersion = "main@synthetic";
    context.readVersion = async () => currentVersion;
    assert.match(
      await readFile(join(REPOSITORY, "src/index.ts"), "utf8"),
      /codeDirectory: managedCodeRoot\(ROOT, bundleMetadata\)/
    );
    const initialVersion = recordingResponse();
    await handleSettingsEndpoint({ method: "GET" } as IncomingMessage, initialVersion.res, "/settings", context);
    assert.equal(JSON.parse(initialVersion.body).version, currentVersion);
    currentVersion += " · OS updated since this release was tested";
    const changedVersion = recordingResponse();
    await handleSettingsEndpoint({ method: "GET" } as IncomingMessage, changedVersion.res, "/settings", context);
    assert.equal(
      JSON.parse(changedVersion.body).version,
      currentVersion,
      "Settings must refresh the live version notice after startup"
    );
    assert.match(
      await readFile(join(REPOSITORY, "src/index.ts"), "utf8"),
      /readVersion: async \(\) => \(await readRunningVersion\(UPDATE_DIR, settingsRuntime\.paths\.updaterDirectory\)\)\.label/
    );
    console.log(
      "bundle admission: shared revision/bus reservation, duplicate refusal, motion/busy gates, Bluetooth key handover, release on queue failure and SIGTERM retention passed"
    );
  } finally {
    await restart.close();
    await closeSettingsFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkAdmissionDeadline(store: SettingsStore): Promise<void> {
  const restart = createSettingsRestart({
    store,
    motionBlockers: () => [],
    scheduleTimeoutMs: 15,
    stopTimeoutMs: 1_000,
  });
  let finishQueue = (): void => {
    throw new Error("queue was not started");
  };
  const queue = new Promise<void>(resolve => {
    finishQueue = resolve;
  });
  let expiredReservationCurrent: boolean | undefined;
  try {
    const reserving = restart.reserve(restart.generation, 3, async stillReserved => {
      assert(stillReserved());
      await queue;
      expiredReservationCurrent = stillReserved();
    });
    await assert.rejects(
      Promise.race([
        reserving,
        delay(150).then(() => {
          throw new Error("queue admission was not bounded");
        }),
      ]),
      /timed out/
    );
    assert.equal(busHeldBy(), null);
    assert.equal(restart.status().state, "idle");
    assert.equal(await restart.reserve(restart.generation, 3), true);
    finishQueue();
    await delay(20);
    assert.equal(expiredReservationCurrent, false, "an expired operation must not inherit a later reservation");
    assert.match(busHeldBy() ?? "", /Cool Eva restart/, "late completion must not release a subsequent restart");
  } finally {
    finishQueue();
    await restart.close();
  }
}

async function checkEndpointAdmission(bundle: UpdateFixture, context: SettingsHttpContext): Promise<void> {
  const savedEnvironment = { PATH: process.env.PATH, UPDATE_FIXTURE: process.env.UPDATE_FIXTURE };
  const trace = join(bundle.root, "commands.txt");
  const body = { expectedGeneration: context.restart.generation, revision: settingsReply(context).revision };
  await copyFile(bundle.state, join(context.runtime.paths.updaterDirectory, "state.json"));
  try {
    Object.assign(process.env, fixtureEnvironment(bundle));
    await writeFile(trace, "");
    const accepted = recordingResponse();
    await handleUpdateEndpoint(updateRequest(body), accepted.res, join(bundle.code, "releases/old"), context);
    assert.equal(accepted.statusCode, 202);
    assert.equal((await readFile(trace, "utf8")).trim(), "systemctl start --no-block cool-eva-update.service");
    assert.equal(busHeldBy(), null);
    await writeFile(trace, "");
    const stale = recordingResponse();
    await handleUpdateEndpoint(
      updateRequest({ ...body, revision: Number(body.revision) - 1 }),
      stale.res,
      join(bundle.code, "releases/old"),
      context
    );
    assert.equal(stale.statusCode, 409);
    const oldProcess = recordingResponse();
    await handleUpdateEndpoint(
      updateRequest({ ...body, expectedGeneration: "earlier-process" }),
      oldProcess.res,
      join(bundle.code, "releases/old"),
      context
    );
    assert.equal(oldProcess.statusCode, 200);
    const held = acquireBus("synthetic active write");
    assert(held.ok);
    try {
      const busy = recordingResponse();
      await handleUpdateEndpoint(updateRequest(body), busy.res, join(bundle.code, "releases/old"), context);
      assert.equal(busy.statusCode, 409);
    } finally {
      held.lease.release();
    }
    const bluetooth = recordingResponse();
    await handleUpdateEndpoint(
      updateRequest(body, { "x-cool-eva-tunnel": "1" }),
      bluetooth.res,
      join(bundle.code, "releases/old"),
      context
    );
    assert.equal(bluetooth.statusCode, 409);
    assert.equal(
      await readFile(trace, "utf8"),
      "",
      "refused requests must never queue the unit or fall through to Git"
    );
    const directory = join(bundle.code, "releases/old");
    const pathContext = { ...context, codeDirectory: managedCodeRoot(directory, await readReleaseMetadata(directory)) };
    const request = updateRequest(
      {
        revision: body.revision,
        changes: { rideLogDirectory: join(bundle.code, "releases/another-release/recordings") },
      },
      { "x-cool-eva": "settings", "content-type": "application/json" }
    );
    request.method = "PATCH";
    const insideAnotherRelease = recordingResponse();
    await handleSettingsEndpoint(request, insideAnotherRelease.res, "/settings", pathContext);
    assert.equal(
      insideAnotherRelease.statusCode,
      409,
      "saved data paths must be outside every release, not only the active one"
    );
  } finally {
    for (const name of ["PATH", "UPDATE_FIXTURE"] as const) {
      const saved = savedEnvironment[name];
      if (saved === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved;
      }
    }
  }
}

function updateRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    headers: { "x-cool-eva": "update", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
}

await checkBundleAdmission();
