import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { isBundleRuntime, readReleaseMetadata } from "../src/release/metadata.ts";
import { osPackagesChanged, readBundleNotices, rollbackNotice } from "../src/release/version.ts";
import { readUpdateStatus } from "../src/release/update-status.ts";
import { handleBundleUpdate, tryBundleUpdate } from "../src/http/bundle-update.ts";
import { handleUpdateEndpoint } from "../src/http/update.ts";
import { handleReleaseHealth, verifyReleaseStorage } from "../src/http/release-health.ts";
import { settingsPaths } from "../src/settings/paths.ts";
import {
  createUpdateFixture,
  fixtureEnvironment,
  readState,
  saveState,
  REPOSITORY,
  type UpdateFixture,
} from "./update-check/fixture.ts";
import { followUpdate } from "../public/lib/update-progress.js";
import { createVirtualClock } from "./virtual-clock.ts";

export async function checkBundleRuntime(): Promise<void> {
  await mkdir(join(REPOSITORY, ".preview-shots"), { recursive: true });
  const directory = await mkdtemp(join(REPOSITORY, ".preview-shots/bundle-runtime-"));
  const savedEnvironment = { PATH: process.env.PATH, UPDATE_FIXTURE: process.env.UPDATE_FIXTURE };
  try {
    for (const name of await readdir(join(REPOSITORY, "scripts/update"))) {
      if (name.endsWith(".sh")) {
        await promisify(execFile)("sh", ["-n", join(REPOSITORY, "scripts/update", name)]);
      }
    }
    const unit = await readFile(join(REPOSITORY, "scripts/update/cool-eva.service"), "utf8");
    for (const required of [
      "StartLimitIntervalSec=120",
      "StartLimitBurst=3",
      "RestartSec=5",
      "RestartMode=normal",
      "OnFailure=cool-eva-rollback.service",
      "ExecStartPre=-/usr/local/libexec/cool-eva-update recover",
      "RuntimeDirectoryMode=0700",
      "RuntimeDirectoryPreserve=yes",
    ]) {
      assert(unit.includes(required), `missing unit contract: ${required}`);
    }
    const fixture = await createUpdateFixture(directory);
    const metadata = await readReleaseMetadata(join(fixture.code, "releases/old"));
    assert.equal(metadata?.commit, "a".repeat(40));
    assert.equal(await readReleaseMetadata(fixture.root), null);
    assert(isBundleRuntime(fixture.root, join(fixture.root, "runtime/bin/node")));
    assert(!isBundleRuntime(fixture.root, "/usr/bin/node"));
    await assert.rejects(
      readReleaseMetadata(fixture.root, join(fixture.root, "runtime/bin/node")),
      /metadata is missing/
    );
    const markerPath = join(fixture.data, "state/installed.json");
    const marker = await readFile(markerPath, "utf8");
    await writeFile(markerPath, '{"installed":false,"archiveGroupId":0}');
    await assert.rejects(verifyReleaseStorage(settingsPaths(fixture.data)), /installation marker is incomplete/);
    await writeFile(markerPath, marker);
    await verifyReleaseStorage(settingsPaths(fixture.data));
    const healthy = recordedResponse();
    await handleReleaseHealth(healthy.response, join(fixture.code, "releases/old"), settingsPaths(fixture.data));
    assert.equal(healthy.status, 200);
    assert.equal(JSON.parse(healthy.body).release, metadata?.release);
    const document = JSON.parse(await readFile(fixture.settings, "utf8"));
    document.migration.source = "legacy";
    await writeFile(fixture.settings, JSON.stringify(document));
    await assert.rejects(verifyReleaseStorage(settingsPaths(fixture.data)), /ENOENT/);
    await writeFile(join(fixture.data, "state/data-move.json"), '{"complete":false}');
    await assert.rejects(verifyReleaseStorage(settingsPaths(fixture.data)), /incomplete/);
    await writeFile(join(fixture.data, "state/data-move.json"), '{"complete":true}');
    await verifyReleaseStorage(settingsPaths(fixture.data));
    document.schemaVersion = 2;
    await writeFile(fixture.settings, JSON.stringify(document));
    const unhealthy = recordedResponse();
    await handleReleaseHealth(unhealthy.response, join(fixture.code, "releases/old"), settingsPaths(fixture.data));
    assert.equal(unhealthy.status, 503);

    Object.assign(process.env, fixtureEnvironment(fixture));
    for (const request of [
      { method: "GET", headers: {} },
      { method: "POST", headers: {} },
      { method: "POST", headers: { "x-cool-eva": "can-restart" } },
    ]) {
      const response = recordedResponse();
      await handleUpdateEndpoint(request as IncomingMessage, response.response, join(fixture.code, "releases/old"));
      assert([403, 405].includes(response.status));
    }
    await writeFile(join(fixture.root, "commands.txt"), "");
    const queued = recordedResponse();
    await handleBundleUpdate(queued.response, join(fixture.data, "updater"));
    assert.equal(queued.status, 202);
    assert.equal(JSON.parse(queued.body).sequence, 1);
    assert.equal(
      (await readFile(join(fixture.root, "commands.txt"), "utf8")).trim(),
      "systemctl start --no-block cool-eva-update.service"
    );
    assert.equal((await readUpdateStatus(join(fixture.data, "updater"))).running, false);
    const metadataPath = join(fixture.code, "releases/old/release.json");
    const intactMetadata = await readFile(metadataPath, "utf8");
    await writeFile(metadataPath, "damaged metadata");
    const repairRequest = recordedResponse();
    assert(
      await tryBundleUpdate(repairRequest.response, join(fixture.code, "releases/old"), {
        executable: join(fixture.code, "releases/old/runtime/bin/node"),
        statusDirectory: join(fixture.data, "updater"),
      })
    );
    assert.equal(repairRequest.status, 202, "a bundle with damaged metadata must queue repair, never fall back to Git");
    await writeFile(metadataPath, intactMetadata);
    for (const name of [
      "bluez",
      "network-manager",
      "linux-image-rpi-v8",
      "raspi-firmware",
      "libc6",
      "libstdc++6",
      "systemd",
    ]) {
      assert.equal(osPackagesChanged(`${name}\t1\n`, `${name}\t1\n`), false);
      assert.equal(osPackagesChanged(`${name}\t1\n`, `${name}\t2\n`), true);
      assert.equal(osPackagesChanged(`${name}:arm64\t1\n`, `${name}:arm64\t1\n`), false);
      assert.equal(osPackagesChanged(`${name}:arm64\t1\n`, `${name}:arm64\t2\n`), true);
    }
    await checkPromotionBaseline(fixture);
    assert.match(
      rollbackNotice({ lastRollback: { from: "test-release", reason: "interrupted" } })!,
      /interrupted.*Update again/
    );
    assert.match(
      rollbackNotice({ lastRollback: { from: "test-release", reason: "edited-release-failed" } })!,
      /edited release/
    );
    await checkProgressPolling();
    console.log(
      "bundle runtime: identity, migration health, CSRF, fixed unit queue, OS drift, rollback text and reconnect polling passed"
    );
  } finally {
    for (const name of ["PATH", "UPDATE_FIXTURE"] as const) {
      const original = savedEnvironment[name];
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkPromotionBaseline(fixture: UpdateFixture): Promise<void> {
  const directory = join(fixture.code, "releases/old");
  const privateDirectory = join(fixture.data, "updater");
  await writeFile(join(directory, "tested-os-packages.txt"), "ii  bluez 999 arm64\n");
  assert.deepEqual(
    await readBundleNotices(directory, privateDirectory),
    [],
    "the original image must not cause a permanent OS-drift notice after catch-up"
  );
  const savedNow = Object.getOwnPropertyDescriptor(performance, "now");
  const started = performance.now();
  try {
    await writeFile(join(fixture.root, "os-packages.txt"), "bluez\t2\nsystemd\t1\n");
    Object.defineProperty(performance, "now", { configurable: true, value: () => started + 61_000 });
    assert.deepEqual(await readBundleNotices(directory, privateDirectory), [
      "OS updated since this release was tested",
    ]);
    const state = await readState(fixture);
    state.osPackages = { old: "bluez\t2\nsystemd\t1" };
    await saveState(fixture, state);
    Object.defineProperty(performance, "now", { configurable: true, value: () => started + 122_000 });
    assert.deepEqual(
      await readBundleNotices(directory, privateDirectory),
      [],
      "a successful promotion records the new local baseline"
    );
  } finally {
    if (savedNow) {
      Object.defineProperty(performance, "now", savedNow);
    } else {
      Reflect.deleteProperty(performance, "now");
    }
  }
}

function recordedResponse(): { response: ServerResponse; status: number; body: string } {
  const recording = {
    status: 0,
    body: "",
    response: undefined as unknown as ServerResponse,
  };
  recording.response = {
    writeHead(status: number) {
      recording.status = status;
    },
    end(body: string) {
      recording.body = body;
    },
  } as unknown as ServerResponse;
  return recording;
}

async function checkProgressPolling(): Promise<void> {
  const clock = createVirtualClock(10_000);
  const savedTimeout = globalThis.setTimeout;
  const savedFetch = globalThis.fetch;
  const savedNow = Object.getOwnPropertyDescriptor(performance, "now");
  let requests = 0;
  const reported: string[] = [];
  try {
    Object.defineProperty(performance, "now", { configurable: true, value: clock.now });
    globalThis.setTimeout = ((callback: () => void, milliseconds: number) =>
      clock.setTimer(callback, milliseconds)) as unknown as typeof setTimeout;
    globalThis.fetch = async () => {
      requests++;
      if (requests === 2) {
        throw new Error("synthetic restart disconnect");
      }
      return new Response(
        JSON.stringify({
          sequence: requests === 1 ? 0 : 1,
          running: requests < 4,
          ok: requests < 4,
          message: `result-${requests}`,
        })
      );
    };
    const follow = followUpdate(1, status => reported.push(status.message));
    await clock.advance(8_000);
    await follow;
    assert.deepEqual(reported, ["result-3", "result-4"]);
  } finally {
    globalThis.setTimeout = savedTimeout;
    globalThis.fetch = savedFetch;
    if (savedNow) {
      Object.defineProperty(performance, "now", savedNow);
    } else {
      Reflect.deleteProperty(performance, "now");
    }
  }
}

await checkBundleRuntime();
