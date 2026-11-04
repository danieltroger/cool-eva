import assert from "assert/strict";
import { execFile } from "child_process";
import { readFile, writeFile, mkdir } from "fs/promises";
import { promisify } from "util";
import { resolve, join } from "path";

export async function checkNetworkMutations(): Promise<void> {
  const outputDirectory = resolve(".preview-shots", "network-mutations");
  await mkdir(outputDirectory, { recursive: true });
  for (const mutation of MUTATIONS) {
    const original = await readFile(mutation.file, "utf8");
    assert.ok(original.includes(mutation.before), `${mutation.name}: mutation site missing`);
    const changed = original.replace(mutation.before, mutation.after);
    try {
      await writeFile(mutation.file, changed);
      await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--check", mutation.file]);
      let rejected = false;
      try {
        await promisify(execFile)(
          process.execPath,
          ["--experimental-strip-types", mutation.check ?? "scripts/check-network-settings.ts"],
          { timeout: 20_000, maxBuffer: 1024 * 1024 }
        );
      } catch (error) {
        const result = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        await writeFile(join(outputDirectory, `${mutation.name}.txt`), output);
        assert.ok(
          !result.killed && !/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/.test(output),
          `${mutation.name}: invalid mutation or timeout`
        );
        rejected = true;
      }
      assert.ok(rejected, `${mutation.name}: SURVIVED`);
      console.log(`KILLED ${mutation.name}`);
    } finally {
      await writeFile(mutation.file, original);
    }
  }
  console.log(`Wi-Fi mutations: ${MUTATIONS.length}/${MUTATIONS.length} killed; original files restored.`);
}

interface Mutation {
  name: string;
  file: string;
  before: string;
  after: string;
  check?: string;
}
const MUTATIONS: Mutation[] = [
  {
    name: "candidate-autoconnect",
    file: "src/wifi/network-save.ts",
    before: "autoconnect: false",
    after: "autoconnect: true",
  },
  {
    name: "candidate-unbounded-auth",
    file: "src/wifi/network-save.ts",
    before: "authRetries: 1",
    after: "authRetries: 0",
  },
  {
    name: "checkpoint-races-trial",
    file: "src/wifi/networks.ts",
    before: "CHECKPOINT_SECONDS = 180",
    after: "CHECKPOINT_SECONDS = 120",
  },
  {
    name: "retire-before-confirm",
    file: "src/wifi/networks.ts",
    before: "this.motion();\n      await this.take",
    after:
      "if (change.replaced) await this.options.backend.remove(change.replaced.uuid);\n      this.motion();\n      await this.take",
  },
  {
    name: "keep-over-ble",
    file: "src/wifi/network-view.ts",
    before: "directWifi(proof, active.address)",
    after: "true",
  },
  {
    name: "password-in-logs",
    file: "src/wifi/network-save.ts",
    before: "await networks.options.backend.add(",
    after: "console.warn(password);\n    await networks.options.backend.add(",
  },
  {
    name: "password-in-argv",
    file: "src/wifi/network-save.ts",
    before: "await networks.options.backend.add(",
    after:
      "const childProcess = await import('child_process'); childProcess.spawn(process.execPath, ['-e', '', password]);\n    await networks.options.backend.add(",
  },
  {
    name: "trial-at-plain-start",
    file: "src/wifi/network-reconciliation.ts",
    before: "if (!pendingNetworkChange(networks)) {\n    if (!profiles.some",
    after:
      "if (!pendingNetworkChange(networks)) {\n    await networks.options.backend.activate(change.uuid);\n    if (!profiles.some",
  },
  {
    name: "ap-change-single-shot",
    file: "src/wifi/networks.ts",
    before: "if (this.now() < this.nextAttempt) return;",
    after: "if (this.now() < this.nextAttempt || change.attempts > 0) return;",
  },
  {
    name: "retry-without-motion-check",
    file: "src/wifi/networks.ts",
    before: "try {\n        this.motion();\n      } catch (error)",
    after: "try {\n        // Mutated motion check.\n      } catch (error)",
  },
  {
    name: "checkpoint-path-not-stored",
    file: "src/wifi/networks.ts",
    before: "change: { ...this.state().change!, checkpoint }",
    after: "change: { ...this.state().change!, checkpoint: null }",
  },
  {
    name: "wrong-inherited-priority",
    file: "src/wifi/network-save.ts",
    before: "replaced?.priority ?? (priorities.length ? Math.max(...priorities) : 0)",
    after: "0",
  },
  {
    name: "promote-before-checkpoint-destroy",
    file: "src/wifi/network-transitions.ts",
    before: 'if (change.phase === "confirming") {',
    after: 'if (change.phase === "confirming") {\n    await backend.policy(change.uuid, change.priority);',
  },
  {
    name: "hotspot-identity-not-updated",
    file: "src/wifi/network-transitions.ts",
    before: "networks.options.hotspotChanged(change.ssid);",
    after: "// Mutated identity update.",
  },
  {
    name: "failed-retry-needs-retyping",
    file: "src/wifi/networks.ts",
    before: '!["saved", "failed", "restored"].includes(change.phase)',
    after: '!["saved"].includes(change.phase)',
  },
  {
    name: "boot-result-hides-switch",
    file: "src/wifi/network-transitions.ts",
    before: "Wi-Fi may switch at power-on.",
    after: "Wi-Fi did not change.",
  },
  {
    name: "lost-keyfile-silently-accepted",
    file: "src/wifi/networks.ts",
    before: "await this.options.backend.verify(change.uuid);",
    after: "// Mutated persistent profile check.",
  },
  {
    name: "dbus-add-can-autoconnect",
    file: "src/wifi/network-dbus.ts",
    before: "settings, 0x21, {}",
    after: "settings, 1, {}",
    check: "scripts/check-network-dbus.ts",
  },
  {
    name: "checkpoint-all-devices",
    file: "src/wifi/network-dbus.ts",
    before: "[await connection.device()], seconds, 0",
    after: "[], seconds, 0",
    check: "scripts/check-network-dbus.ts",
  },
  {
    name: "dbus-failure-logs-secret-parameters",
    file: "src/wifi/network-dbus.ts",
    before: "    } catch (error) {\n      console.warn(`wifi-settings: NetworkManager",
    after:
      "    } catch (error) {\n      console.warn(JSON.stringify(parameters));\n      console.warn(`wifi-settings: NetworkManager",
    check: "scripts/check-network-dbus.ts",
  },
  {
    name: "recovery-activates-excluded-candidate",
    file: "src/wifi/recovery-profile.ts",
    before: "if (networkCandidateExcluded(uuid)) continue;",
    after: "// Mutated candidate exclusion.",
  },
  {
    name: "recovery-activates-unknown-orphan",
    file: "src/wifi/recovery-profile.ts",
    before: 'if (/^(?:netplan-)?cool-eva-/.test(name) && autoconnect === "no") continue;',
    after: "// Mutated orphan exclusion.",
  },
  {
    name: "network-csrf-json-without-header",
    file: "src/http/networks.ts",
    before: 'req.headers["x-cool-eva"] !== "settings" ||',
    after: "false ||",
    check: "scripts/check-network-http.ts",
  },
  {
    name: "boot-lost-candidate-not-detected",
    file: "src/wifi/network-reconciliation.ts",
    before: "if (!profiles.some(profile => profile.uuid === change.uuid)) {",
    after: "if (false) {",
  },
  {
    name: "netplan-change-lands-in-keyfile",
    file: "src/wifi/network-save.ts",
    before: 'if (replaced?.backend === "netplan" && candidate?.backend !== "netplan") {',
    after: "if (false) {",
  },
  {
    name: "failed-save-keeps-password-in-nm",
    file: "src/wifi/network-save.ts",
    before: "await networks.options.backend.discard(uuid);",
    after: "// Mutated failed candidate cleanup.",
  },
  {
    name: "failed-result-polls-without-bound",
    file: "src/wifi/network-reconciliation.ts",
    before: "if (networks.now() >= networks.restorationDeadline) {",
    after: "if (false) {",
  },
  {
    name: "startup-fault-blocks-existing-recovery",
    file: "src/wifi/network-startup.ts",
    before: "  const settings = runtime.store.read();",
    after:
      '  const { acquireWifiOperation } = await import("./operation.ts"); acquireWifiOperation("settings");\n  const settings = runtime.store.read();',
  },
  {
    name: "transient-startup-list-is-permanent-fault",
    file: "src/wifi/network-reconciliation.ts",
    before: "if (!pendingNetworkChange(networks)) return;",
    after: "// Mutated boot listing refusal.",
  },
  {
    name: "hotspot-rollback-forgets-confirmed-identity",
    file: "src/wifi/network-transitions.ts",
    before: '...(change.purpose === "hotspot" ? { hotspotUuid: change.uuid } : {}),',
    after: "// Mutated kept hotspot identity.",
  },
  {
    name: "use-previous-leaves-promoted-candidate-autoconnecting",
    file: "src/wifi/network-transitions.ts",
    before: "await backend.policy(change.uuid, change.priority, false);",
    after: "// Mutated candidate quarantine.",
  },
  {
    name: "result-readback-bypasses-operation-queue",
    file: "src/wifi/networks.ts",
    before: "return this.serial(() => networkView(this, proof));",
    after: "return networkView(this, proof);",
  },
  {
    name: "readback-hides-missing-candidate-warning",
    file: "src/wifi/network-view.ts",
    before: "if (!change || profiles.some(profile => profile.uuid === change.uuid)) {",
    after: "if (true) {",
  },
  {
    name: "installer-repair-forgets-hotspot-identity",
    file: "scripts/configure-network-purposes.ts",
    before: "...(hotspot ? { hotspotUuid: hotspot.uuid } : {}),",
    after: "// Mutated installer identity hand-off.",
  },
  {
    name: "resumed-retirement-keeps-rolled-back-hotspot-name",
    file: "src/wifi/network-transitions.ts",
    before: 'change.purpose === "hotspot" &&\n      settings.kind === "ready" &&',
    after: 'false &&\n      settings.kind === "ready" &&',
  },
];
await checkNetworkMutations();
