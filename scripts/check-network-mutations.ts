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
    file: "src/wifi/networks.ts",
    before: 'if (["saved", "failed", "restored"].includes(change.phase)) {',
    after:
      'if (["saved", "failed", "restored"].includes(change.phase)) {\n        await this.options.backend.activate(change.uuid);',
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
];
await checkNetworkMutations();
