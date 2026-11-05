import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { verifyPostInstall, verificationScript, validateVerificationReceipt } from "./verification.ts";
import { assertSupervisedStartup } from "./startup.ts";

export async function checkGuestVerification(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const names = [
    "fixture",
    "jq-manual",
    "app-active",
    "wasm-guard",
    "app-enabled",
    "dispatcher",
    "capture-off",
    "settings-mode",
    "updater-mode",
    "hotspot-mode",
    "os-power-policy",
    "networks",
  ];
  const goodReceipt =
    names.flatMap(name => [`START ${name} 1.00`, `END ${name} 1.00 2.00 0`]).join("\n") + "\nCOMPLETE\n";
  validateVerificationReceipt(goodReceipt);
  for (const bad of [
    "",
    goodReceipt.replace("END jq-manual 1.00 2.00 0", "END jq-manual 1.00 2.00 1"),
    goodReceipt.replace("END networks 1.00 2.00 0\n", ""),
    goodReceipt.replace("START fixture 1.00\nEND fixture 1.00 2.00 0\n", ""),
  ]) {
    assert.throws(() => validateVerificationReceipt(bad));
  }
  for (const variant of [
    "delayed",
    "disconnect",
    "failed",
    "signal",
    "nonzero-active",
    "incomplete",
    "never-started",
    "never-started-zero-job",
    "budget",
  ] as const) {
    const neverStarted = variant === "never-started" || variant === "never-started-zero-job";
    let milliseconds = 0;
    let starts = 0;
    let polls = 0;
    const calls: string[] = [];
    const execute = async (
      _guest: { key: string; knownHosts: string; port: number },
      command: string,
      timeout?: number
    ): Promise<string> => {
      assert(Number.isInteger(timeout), "Node's execFile timeout must be an integer");
      assert(timeout! <= 600_000 - milliseconds);
      calls.push(command);
      if (command.includes("base64 -d")) {
        starts++;
        const setup = Buffer.from(/'([A-Za-z0-9+/=]+)' \| base64/.exec(command)![1], "base64").toString();
        assert(setup.includes("/run/systemd/system/cool-eva-qemu-verify.service"));
        assert(setup.includes("TimeoutStartSec=infinity"));
        assert(!setup.includes("reset-failed"));
        if (variant === "disconnect") {
          throw Object.assign(new Error("fixture submission disconnect"), { code: 255 });
        }
        return "";
      }
      assert(command.includes("systemctl show"));
      assert(!command.includes("systemctl start"));
      polls++;
      if (variant === "disconnect" && polls === 1) {
        throw Object.assign(new Error("fixture observation disconnect"), { code: 255 });
      }
      if ((variant === "delayed" && milliseconds < 110_000) || variant === "budget") {
        return "LoadState=loaded\nActiveState=activating\nResult=success\nJob=42\nMarker=1\n\nRECEIPT\nSTART fixture 1.00\n";
      }
      const state = neverStarted ? "inactive" : ["failed", "signal"].includes(variant) ? "failed" : "active";
      return `LoadState=loaded\nActiveState=${state}\nResult=${variant === "signal" ? "signal" : variant === "failed" ? "exit-code" : "success"}\nExecMainCode=${variant === "signal" ? 2 : 1}\nExecMainStatus=${variant === "nonzero-active" ? 42 : 0}\nJob=${variant === "never-started-zero-job" ? "0" : ""}\nMarker=${neverStarted ? 0 : 1}\n\nRECEIPT\n${variant === "incomplete" ? goodReceipt.replace("END networks 1.00 2.00 0\n", "") : goodReceipt}`;
    };
    const run = () =>
      verifyPostInstall({ key: "unused", knownHosts: "unused", port: 0 }, directory, execute, {
        now: () => milliseconds,
        elapsed: started => milliseconds - started + 0.25,
        wait: async duration => {
          milliseconds += variant === "budget" ? 150_000 : Math.max(duration, 30_000);
        },
      });
    if (["delayed", "disconnect"].includes(variant)) {
      await run();
    } else if (variant === "failed" || variant === "signal") {
      await assert.rejects(run, error => {
        assert(error instanceof Error);
        assert.match(error.message, /verification failed/);
        if (variant === "signal") {
          assert.match(error.message, /Result=signal/);
        }
        return true;
      });
      assert(milliseconds < 600_000, `${variant} must fail before the overall budget expires`);
    } else {
      await assert.rejects(
        run,
        variant === "budget" ? /overall budget/ : neverStarted ? /not submitted/ : /verification|record|start and end/i
      );
    }
    assert.equal(starts, 1, `${variant} must submit exactly once`);
    assert(polls > 0);
    if (neverStarted) {
      assert.equal(milliseconds, 0);
    }
    assert((await readFile(join(directory, "post-install-verification.txt"), "utf8")).includes("Observed"));
  }
  const script = verificationScript();
  // Execute the generated children with synthetic commands, not an independently rewritten job.
  for (const variant of ["valid", "non-final-failure", "dropped-check", "missing-end"] as const) {
    const root = join(directory, variant);
    await mkdir(root);
    let local = script
      .replaceAll("/run/cool-eva-qemu-verify", join(root, "verify"))
      .replaceAll("test -e /etc/cool-eva-qemu-fixture", "true")
      .replaceAll("read started idle < /proc/uptime", "started=1.00")
      .replaceAll("read finished idle < /proc/uptime", "finished=2.00");
    for (const line of local.split("\n").filter(line => line.startsWith("step "))) {
      const name = /^step '([^']+)'/.exec(line)![1];
      local = local.replace(
        line,
        `step '${name}' '${variant === "non-final-failure" && name === "jq-manual" ? "false; echo must-not-run" : "true"}'`
      );
    }
    if (variant === "dropped-check") {
      local = local.replace("step 'jq-manual' 'true'", "");
    }
    if (variant === "missing-end") {
      local = local.replace("printf 'END %s %s %s %s\\n'", "printf 'MISSING %s %s %s %s\\n'");
    }
    const file = join(root, "script.sh");
    await writeFile(file, local);
    const child = promisify(execFile)("sh", [file]);
    if (variant === "non-final-failure") {
      await assert.rejects(child);
      assert(!(await readFile(join(root, "verify.receipt"), "utf8")).includes("START app-active"));
    } else {
      await child;
      const receipt = await readFile(join(root, "verify.receipt"), "utf8");
      if (variant === "valid") {
        validateVerificationReceipt(receipt);
      } else {
        assert.throws(() => validateVerificationReceipt(receipt));
      }
    }
    await assert.rejects(promisify(execFile)("sh", [file]), "The once-only marker must refuse another execution");
  }
  const positive =
    "Starting cool-eva.service - Cool Eva telemetry...\nStarted cool-eva.service - Cool Eva telemetry.\n";
  assertSupervisedStartup(positive);
  for (const journal of [
    "",
    "unrelated journal",
    ...[
      "current helper is unavailable",
      "previous helper is unavailable",
      "no working helper",
      "helper failed; retained helpers could not repair it",
      "Unsafe updater state",
      "RECOVERY FAILED",
    ].map(text => positive + `cool-eva update: ${text}\n`),
  ]) {
    assert.throws(() => assertSupervisedStartup(journal));
  }
  console.log(
    "guest verification: one submit, delayed completion, disconnect, named failure, signal, inactive/no-job, receipt completeness and overall budget passed"
  );
}
