import assert from "node:assert/strict";
import { cp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  createUpdateFixture,
  fixtureEnvironment,
  invokeUpdater,
  publishFixtureRelease,
  readState,
  repackFixtureRelease,
  REPOSITORY,
  quote,
} from "../update-check/fixture.ts";
import { renderInstaller } from "../release/installer.ts";
import type { ReleaseMetadata } from "../release/manifest.ts";
import { writeFileInventory } from "../release/files.ts";
import { runInTerminal } from "./terminal.ts";

export async function checkExistingBootstrap(directory: string, only?: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  let selected = 0;
  for (const variant of [
    "same-release",
    "pending",
    "edited",
    "trial-rerun",
    "install-tag",
    "missing-helper",
    "self-test-fault",
  ]) {
    if (only && only !== variant) continue;
    selected++;
    const fixture = await createUpdateFixture(directory);
    const environment = fixtureEnvironment(fixture);
    await writeFile(
      join(fixture.commandDirectory, "uname"),
      '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo aarch64; fi\n',
      { mode: 0o755 }
    );
    await writeFile(join(fixture.commandDirectory, "dpkg"), "#!/bin/sh\necho arm64\n", { mode: 0o755 });
    // The handoff assertions require actual kernel locks, unlike the portable command stubs.
    if (process.platform === "linux") {
      await rm(join(fixture.commandDirectory, "flock"), { force: true });
    } else {
      console.log("SKIP real util-linux flock handoff on macOS; functional repair checks still run");
    }
    const frozen = join(REPOSITORY, "scripts/install-check/fixtures/updater-v1");
    const hashes: Record<string, string> = JSON.parse(await readFile(join(frozen, "sha256.json"), "utf8"));
    for (const [name, expected] of Object.entries(hashes)) {
      const source = await readFile(join(frozen, name));
      assert.equal(createHash("sha256").update(source).digest("hex"), expected);
      await writeFile(join(fixture.code, "releases/old/scripts/update", name), source);
    }
    const validate = join(fixture.root, "validate.ts");
    let validation = await readFile(join(REPOSITORY, "src/install/updater.ts"), "utf8");
    validation = validation
      .replaceAll('"./commands.ts"', JSON.stringify(pathToFileURL(join(REPOSITORY, "src/install/commands.ts")).href))
      .replaceAll(
        '"../settings/paths.ts"',
        JSON.stringify(pathToFileURL(join(REPOSITORY, "src/settings/paths.ts")).href)
      )
      .replaceAll("/opt/cool-eva", fixture.code);
    validation = validation.replaceAll("/etc/cool-eva/update.json", fixture.configuration);
    await writeFile(validate, validation);
    const native = `#!/bin/sh
case "$*" in
 *src/install/main.ts*) exec ${quote(process.execPath)} "$@" ;;
 *) exec ${quote(process.execPath)} --experimental-strip-types ${quote(join(REPOSITORY, "scripts/update-check/command.ts"))} fixture-node "$@" ;;
esac
`;
    const main = `import {rm,writeFile} from 'node:fs/promises';
import {validateInstalledHelper} from ${JSON.stringify(pathToFileURL(validate).href)};
const helper=${JSON.stringify(join(fixture.code, "updater/current/run.sh"))};
${variant === "missing-helper" ? "await rm(helper);" : variant === "self-test-fault" ? 'await writeFile(helper,"#!/bin/sh\\nif [ \\"${1:-}\\" = self-test ]; then exit 88; fi\\nexit 0\\n");' : ""}
await validateInstalledHelper(); console.log('BOOTSTRAP_NODE');
`;
    await mkdir(join(fixture.code, "releases/old/src/install"));
    await writeFile(join(fixture.code, "releases/old/src/install/main.ts"), main);
    await writeFile(join(fixture.code, "releases/old/runtime/bin/node"), native, { mode: 0o755 });
    await writeFileInventory(join(fixture.code, "releases/old"));
    let target = join(fixture.code, "releases/old");
    let metadata: ReleaseMetadata = JSON.parse(await readFile(join(target, "release.json"), "utf8"));
    const tag =
      variant === "install-tag" || variant === "trial-rerun"
        ? await publishFixtureRelease(fixture, "new", "b".repeat(40))
        : `cool-eva-${metadata.release}`;
    if (variant === "install-tag" || variant === "trial-rerun") {
      const candidate = join(fixture.code, "releases/new");
      await mkdir(join(candidate, "src/install"));
      await writeFile(join(candidate, "src/install/main.ts"), main);
      await writeFile(join(candidate, "runtime/bin/node"), native, { mode: 0o755 });
      await writeFileInventory(candidate);
      await repackFixtureRelease(fixture, "new", tag);
      metadata = JSON.parse(await readFile(join(candidate, "release.json"), "utf8"));
      if (variant === "trial-rerun") {
        await invokeUpdater(fixture, "update");
        const current = (await readState(fixture)).current;
        assert.match(current, /^trial\./, "Use a real updater promotion, not a handwritten directory name");
        target = join(fixture.code, "releases", current);
      }
    } else {
      await mkdir(join(fixture.root, "assets", tag));
      await cp(join(target, "release.json"), join(fixture.root, "assets", tag, "release.json"));
      await repackFixtureRelease(fixture, "old", tag);
    }
    if (variant === "pending") {
      const state = await readState(fixture);
      state.pending = { target: "synthetic-trial", rollback: state.current, snapshot: "synthetic", phase: "trial" };
      await writeFile(fixture.state, JSON.stringify(state));
    }
    if (["same-release", "pending", "edited", "install-tag"].includes(variant)) {
      await rm(join(fixture.code, "updater"), { recursive: true });
    }
    if (variant === "edited") {
      await writeFile(join(target, "src/index.ts"), "// synthetic owner edit\n");
    }
    const before = await readFile(fixture.state);
    const dispatcher = join(fixture.root, "dispatch.sh");
    await writeFile(
      dispatcher,
      (await readFile(join(REPOSITORY, "scripts/update/dispatch.sh"), "utf8")).replace(
        "helper_root=/opt/cool-eva/updater",
        `helper_root=${quote(join(fixture.code, "updater"))}`
      )
    );
    const entry = join(fixture.root, "update-entry");
    await writeFile(
      entry,
      `#!/bin/sh
cp ${quote(fixture.state)} ${quote(join(fixture.root, "before-install-tag.json"))}
exec sh ${quote(dispatcher)} "$1" --config ${quote(fixture.configuration)} "$2"
`,
      { mode: 0o755 }
    );
    let installer = renderInstaller(await readFile(join(REPOSITORY, "install.sh"), "utf8"), metadata);
    const catchUpStart = installer.indexOf("catch_up_os() {");
    const catchUpEnd = installer.indexOf("stop_progress() {", catchUpStart);
    installer = installer.slice(0, catchUpStart) + "catch_up_os() { :; }\n\n" + installer.slice(catchUpEnd);
    for (const [source, destination] of [
      ["/var/cache/cool-eva-install", join(fixture.root, "cache")],
      ["/opt/cool-eva", fixture.code],
      ["/var/lib/cool-eva", fixture.data],
      ["/usr/local/libexec/cool-eva-update", entry],
    ]) {
      installer = installer.replaceAll(source, destination);
    }
    const script = join(fixture.root, "install.sh");
    await writeFile(script, installer);
    const result = await runInTerminal(
      "/bin/sh",
      [script],
      [["Type BENCH to confirm stable bench power: ", "BENCH\n"]],
      environment,
      process.platform === "linux" ? 10_000 : 20_000
    );
    if (["pending", "edited", "missing-helper", "self-test-fault"].includes(variant)) {
      assert.notEqual(result.code, 0, result.output);
      assert(!result.output.includes("BOOTSTRAP_NODE"));
      if (variant === "pending") {
        assert.match(result.output, /release changed while setup was starting/);
      }
      if (variant === "edited") {
        assert.match(result.output, /Recorded release was edited/);
      }
    } else {
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /BOOTSTRAP_NODE/);
    }
    if (variant === "install-tag") {
      assert.deepEqual(
        await readFile(join(fixture.root, "before-install-tag.json")),
        before,
        "Repair must not alter the journal"
      );
      assert.match((await readState(fixture)).current, /^trial\./);
    } else {
      assert.deepEqual(
        await readFile(fixture.state),
        before,
        "Helper repair/validation must not change recovery state"
      );
    }
    console.log(`existing bootstrap: ${variant} passed${process.platform === "linux" ? " with real flock" : ""}`);
  }
  assert(selected > 0, "Unknown existing bootstrap case");
}
