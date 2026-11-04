import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createOsUpdateGate, osUpdatePowerAvailable, OS_POWER_KEYS } from "../src/os-updates.ts";
import { handleOsUpdateReady } from "../src/http/os-update-ready.ts";
import type { ServiceGateReadings } from "../src/vcu/service-gate.ts";
import { networkProfile } from "../src/install/networks.ts";
import { installerOneLine, installerRemoteCommand, renderInstaller } from "./release/installer.ts";
import { createReleaseMetadata } from "./release/manifest.ts";
import { readBundleInputs } from "./release/inputs.ts";
import { assertPublicationAllowed } from "./release/publish.ts";
import { checkInstallerInput } from "./install-check/input-check.ts";
import { checkPublicationOrder } from "./install-check/publication-check.ts";
import { accessoryBootConfiguration } from "../src/install/accessories.ts";
import { checkBootstrap } from "./install-check/bootstrap-check.ts";
import { checkStartupHealth } from "./install-check/health-check.ts";
import { checkOsUpdateCondition } from "./install-check/os-condition-check.ts";

export async function checkBundleInstall(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  await mkdir(join(root, ".preview-shots"), { recursive: true });
  const directory = await mkdtemp(join(root, ".preview-shots/bundle-install-check-"));
  try {
    const inputs = await readBundleInputs(root);
    const metadata = createReleaseMetadata(inputs, {
      commit: "a".repeat(40),
      channel: "main",
      branch: "main",
      epoch: "1793736000",
    });
    const installer = renderInstaller(await readFile(join(root, "install.sh"), "utf8"), metadata);
    assert(installer.includes(`INSTALL_TAG='cool-eva-main-${"a".repeat(40)}'`));
    assert(installer.includes(inputs.testedImage.url));
    assert(!installer.includes("@COOL_EVA_"));
    assert.throws(() => renderInstaller(installer, metadata), /markers/);
    assert.throws(() => renderInstaller("@COOL_EVA_RELEASE_TAG@", { ...metadata, release: "unsafe'" }), /identity/);
    const environment = {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "danieltroger/cool-eva",
      GITHUB_SHA: metadata.commit,
      GITHUB_REF: "refs/heads/main",
    };
    assertPublicationAllowed(metadata, environment);
    for (const patch of [
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REPOSITORY: "fork/cool-eva" },
      { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_SHA: "b".repeat(40) },
    ]) {
      assert.throws(() => assertPublicationAllowed(metadata, { ...environment, ...patch }));
    }
    assertPublicationAllowed(
      { ...metadata, channel: "branch-test", branch: "feature", release: `branch-test-${metadata.commit}` },
      { ...environment, GITHUB_REF: "refs/heads/feature" }
    );
    const shim = join(directory, "ssh");
    await writeFile(shim, '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$COOL_EVA_ARGV_FILE"\n', { mode: 0o755 });
    await writeFile(join(directory, "sudo"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const argumentsFile = join(directory, "arguments");
    await promisify(execFile)("sh", ["-c", installerOneLine()], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, COOL_EVA_ARGV_FILE: argumentsFile },
    });
    assert.deepEqual((await readFile(argumentsFile, "utf8")).split("\0"), [
      "-tt",
      "pi@cool-eva.local",
      installerRemoteCommand(),
      "",
    ]);
    assert(!/[`$\r\n]/.test(installerOneLine()));
    checkPowerGate();
    checkLoopbackRoute();
    const profile = networkProfile(
      { ssid: "Synthetic;é", password: " a\\b\tc " },
      "11111111-1111-4111-8111-111111111111"
    );
    assert(profile.includes("ssid=83;121;110;116;104;101;116;105;99;59;195;169;\n"));
    assert(profile.includes("psk=\\sa\\\\b\\tc\\s\n"));
    assert.throws(() => networkProfile({ ssid: "Synthetic", password: "bad\nnew=field" }));
    assert(
      !accessoryBootConfiguration({ coolantProbesEnabled: false, radiatorFanEnabled: false }).includes("dtparam=")
    );
    assert.equal(
      accessoryBootConfiguration({ coolantProbesEnabled: true, radiatorFanEnabled: false }).trim().split("\n").at(-1),
      "dtparam=spi=on"
    );
    const fanBoot = accessoryBootConfiguration({ coolantProbesEnabled: false, radiatorFanEnabled: true });
    assert(fanBoot.includes("gpio=17,op,dl\ngpio=27,op,dl\ndtoverlay=pwm,pin=18,func=2\n"));
    assert(!fanBoot.includes("spi=on"));
    await checkInstallerInput(directory, root);
    await checkPublicationOrder(join(directory, "publish"), metadata);
    await checkBootstrap(join(directory, "bootstrap"), root);
    await checkStartupHealth();
    await checkOsUpdateCondition(join(directory, "power-condition"), root);
    console.log(
      "bundle install: shell argument boundaries, immutable identity, publication guards, charging power/freshness, loopback admission, network escaping and hidden public-only input passed"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function powerReadings(): ServiceGateReadings {
  return {
    speed_can_kmh: { value: 0, ageMs: 0 },
    soc: { value: 40, ageMs: 0 },
    pack_kw: { value: 2, ageMs: 0 },
    charge_manager_status: { value: 8, ageMs: 0 },
    mains_v: { value: 230, ageMs: 0 },
    mains_a: { value: 10, ageMs: 0 },
    fast_dc_contactor: { value: 0, ageMs: 0 },
  };
}

function checkPowerGate(): void {
  const readings = powerReadings();
  assert(osUpdatePowerAvailable(readings));
  for (const [key, value] of [
    ["speed_can_kmh", 1],
    ["soc", 71],
    ["soc", -1],
    ["pack_kw", -2],
    ["pack_kw", 0],
    ["charge_manager_status", 0],
    ["mains_v", 0],
    ["mains_a", 0],
  ] as const) {
    assert(!osUpdatePowerAvailable({ ...readings, [key]: { value, ageMs: 0 } }), key);
  }
  for (const key of OS_POWER_KEYS.filter(key => key !== "fast_dc_contactor")) {
    for (const ageMs of [null, -1, 6000]) {
      assert(
        !osUpdatePowerAvailable({ ...readings, [key]: { value: readings[key]!.value, ageMs } }),
        `${key} freshness`
      );
    }
  }
  assert(
    osUpdatePowerAvailable({
      ...readings,
      mains_v: { value: null, ageMs: null },
      mains_a: { value: null, ageMs: null },
      fast_dc_contactor: { value: 1, ageMs: 0 },
    })
  );
  assert(
    !osUpdatePowerAvailable({
      ...readings,
      mains_v: { value: null, ageMs: null },
      fast_dc_contactor: { value: 1, ageMs: 1001 },
    })
  );
  let now = 0;
  let busy = false;
  const gate = createOsUpdateGate(
    key => readings[key]!,
    () => busy,
    { now: () => now, since: mark => now - mark }
  );
  try {
    assert(!gate.ready());
    for (now = 1000; now < 120000; now += 1000) {
      assert(!gate.ready());
    }
    assert(gate.ready());
    busy = true;
    assert(!gate.ready());
    busy = false;
    assert(gate.ready());
    now += 6000;
    assert(!gate.ready(), "A stalled sampler resets the two-minute qualification");
    for (let elapsed = 0; elapsed <= 120000; elapsed += 1000) {
      now += 1000;
      gate.ready();
    }
    assert(gate.ready());
    readings.speed_can_kmh = { value: 1, ageMs: 0 };
    assert(!gate.ready());
  } finally {
    gate.close();
  }
  readings.speed_can_kmh = { value: 0, ageMs: 0 };
  for (let elapsed = 0; elapsed < 121000; elapsed += 1000) {
    now += 1000;
    assert(!gate.ready(), "Closed gate must never reopen");
  }
}

function checkLoopbackRoute(): void {
  for (const [method, address, headers, allowed] of [
    ["GET", "127.0.0.1", {}, true],
    ["GET", "::1", {}, true],
    ["GET", "::ffff:127.0.0.1", {}, true],
    ["POST", "127.0.0.1", {}, false],
    ["GET", "192.0.2.1", {}, false],
    ["GET", "127.0.0.1", { "x-cool-eva-tunnel": "" }, false],
  ] as const) {
    let status = 0;
    let body = "";
    const response = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (contents: string) => {
        body = contents;
      },
    } as unknown as ServerResponse;
    handleOsUpdateReady(
      { method, headers, socket: { remoteAddress: address } } as unknown as IncomingMessage,
      response,
      { ready: () => true, close: () => {} }
    );
    assert.equal(status, allowed ? 200 : 403);
    assert.equal(JSON.parse(body).ok, allowed);
  }
}

await checkBundleInstall();
