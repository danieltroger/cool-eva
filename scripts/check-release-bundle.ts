import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyBundleArtifacts } from "./release/build.ts";
import { NPM_CI_ARGUMENTS } from "./release/assemble.ts";
import {
  hashFile,
  selectSourcePaths,
  validateArchivePath,
  writeFileInventory,
  RUNTIME_SCRIPTS,
} from "./release/files.ts";
import { parseBundleInputs, readBundleInputs, validateBuildIdentity } from "./release/inputs.ts";
import { createReleaseMetadata, renderReleaseManifest } from "./release/manifest.ts";
import { assertUsocketUnavailable, selectNativeBinaries, validateArm64Elf } from "./release/native.ts";
import {
  assertNoBuildDependencies,
  assertNoDevDependencies,
  preserveAddonLicenses,
  pruneRuntimeDependencies,
  type DependencyLock,
} from "./release/dependencies.ts";
import { assertRuntimePayload, copyRuntimePayload, RUNTIME_ROOTS } from "./release/payload.ts";

export async function checkReleaseBundle(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const inputs = await readBundleInputs(root);
  assert.equal(NPM_CI_ARGUMENTS[0], "ci");
  assert(NPM_CI_ARGUMENTS.includes("--omit=dev"), "npm ci must explicitly omit dev dependencies");
  const commit = "a".repeat(40);
  const identity = { commit, channel: "branch-can-fix", branch: "fix/can", epoch: "1793736000" };
  validateBuildIdentity(commit, identity.channel, identity.branch, identity.epoch);
  for (const invalid of ["latest", "24.x", "24.22.2\narchive=evil"]) {
    assert.throws(() => parseBundleInputs({ ...inputs, node: { ...inputs.node, version: invalid } }));
  }
  assert.throws(() => parseBundleInputs({ ...inputs, builder: { ...inputs.builder, image: "debian:trixie-slim" } }));
  assert.throws(() => parseBundleInputs({ ...inputs, node: { ...inputs.node, sha256: "a".repeat(63) } }));
  assert.throws(() =>
    parseBundleInputs({
      ...inputs,
      testedImage: { ...inputs.testedImage, url: "https://example.invalid/latest.img.xz" },
    })
  );
  assert.throws(() => parseBundleInputs({ ...inputs, runtimeLibraries: ["/tmp/libother.so"] }));
  assert.throws(() => validateBuildIdentity("HEAD", identity.channel, identity.branch, identity.epoch));
  assert.throws(() => validateBuildIdentity(commit, "main\narchive=evil", identity.branch, identity.epoch));
  assert.throws(() => validateBuildIdentity(commit, identity.channel, "$(command)", identity.epoch));

  const required = ["package.json", "package-lock.json", "LICENSE", "src/index.ts", "scripts/release/inputs.json"];
  const selected = selectSourcePaths([
    ...required,
    "public/app.js",
    "scripts/can-capture/capture.sh",
    "scripts/check-example.ts",
    "docs/setup.md",
    "ride-logs/trip.celog",
    "ride-log-key.private.pem",
    ".env",
    ".claude/notes.txt",
    "map/node_modules/cache",
  ]);
  assert(selected.includes("public/app.js"));
  assert(selected.includes("scripts/can-capture/capture.sh"));
  assert(!selected.includes("docs/setup.md"));
  assert(!selected.includes("scripts/check-example.ts"));
  assert.equal(selected.length, required.length + 2);
  assert.throws(() => selectSourcePaths(required.filter(path => path !== "src/index.ts")));
  for (const path of [
    "../outside",
    "/etc/passwd",
    "src/../outside",
    "src/one\ntwo",
    "src/key.private.pem",
    "src/standalone.celog",
    "public/ride-logs/entry.txt",
    "public/vcu-params/entry.txt",
    "public/wifi-diag/entry.txt",
    "public/ride-captures/entry.txt",
    "public/captures/entry.txt",
    "public/.git/config",
  ]) {
    assert.throws(() => validateArchivePath(path), path);
  }

  const metadata = createReleaseMetadata(inputs, identity);
  const checksum = "b".repeat(64);
  const manifest = renderReleaseManifest(metadata, checksum, 1024);
  assert(manifest.includes(`commit=${commit}\n`));
  assert(manifest.includes(`sha256=${checksum}\n`));
  assert(manifest.includes("archive=bundle.tar.zst\n"));
  assert(manifest.endsWith("bytes=1024\n"));
  assert.throws(() => renderReleaseManifest(metadata, "broken", 1024));
  assert.throws(() => renderReleaseManifest(metadata, checksum, 0));
  assert.throws(() => renderReleaseManifest({ ...metadata, channel: "main\narchive=evil" }, checksum, 1024));

  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header[18] = 183;
  validateArm64Elf(header, "ARM64 fixture");
  const x86Header = Buffer.from(header);
  x86Header[18] = 62;
  assert.throws(() => validateArm64Elf(x86Header, "x86 fixture"));
  const arm32Header = Buffer.from(header);
  arm32Header[4] = 1;
  assert.throws(() => validateArm64Elf(arm32Header, "ARM32 fixture"));
  assert.throws(() => validateArm64Elf(header.subarray(0, 10), "truncated fixture"));
  assert.deepEqual(selectNativeBinaries("better-sqlite3", ["better_sqlite3.node", "test_extension.node"]), [
    "better_sqlite3.node",
  ]);
  assert.throws(() => selectNativeBinaries("better-sqlite3", ["test_extension.node"]), /missing production native/);
  assert.throws(() => selectNativeBinaries("socketcan", ["can.node"]), /can_signals/);
  const workflow = await readFile(join(root, ".github/workflows/release-bundle.yml"), "utf8");
  const actions = workflow.split("\n").filter(line => line.includes("uses:"));
  assert.equal(actions.length, 3);
  for (const action of actions) {
    assert.match(action, /uses: actions\/[a-z-]+@[a-f0-9]{40} # v\d+\.\d+\.\d+$/);
  }

  const temporaryParent = join(root, ".preview-shots");
  await mkdir(temporaryParent, { recursive: true });
  const directory = await mkdtemp(join(temporaryParent, "release-check-"));
  try {
    await checkDependencyPruning(join(directory, "dependencies"));
    await checkRuntimePayload(join(directory, "payload-source"), join(directory, "payload"));
    await mkdir(join(directory, "public"));
    await writeFile(join(directory, "public/app.js"), "first content\n");
    await symlink("app.js", join(directory, "public/alias.js"));
    await writeFileInventory(directory);
    const firstHash = await hashFile(join(directory, "public/app.js"));
    const inventory = await readFile(join(directory, "files.sha256"), "utf8");
    assert(inventory.includes(`${firstHash}  public/app.js\n`));
    assert(inventory.includes(`${firstHash}  public/alias.js\n`));
    await writeFileInventory(directory);
    assert.equal(await readFile(join(directory, "files.sha256"), "utf8"), inventory);
    await writeFile(join(directory, "public/app.js"), "edited content\n");
    assert.notEqual(await hashFile(join(directory, "public/app.js")), firstHash);
    await symlink("../../outside", join(directory, "public/escape"));
    await assert.rejects(writeFileInventory(directory), /symlink escapes/);
    await rm(join(directory, "public/escape"));
    await writeFile(join(directory, "key.private.pem"), "synthetic private-file fixture\n");
    await assert.rejects(writeFileInventory(directory), /private material/);
    const output = join(directory, "output");
    const produced = join(output, ".build/output");
    await mkdir(produced, { recursive: true });
    for (const name of ["bundle.tar.zst", "manifest.txt", "release.json", "tested-os-packages.txt"]) {
      await writeFile(join(produced, name), `fixture ${name}\n`);
    }
    await copyBundleArtifacts(produced, output);
    assert.equal(await readFile(join(output, "manifest.txt"), "utf8"), "fixture manifest.txt\n");
    await assert.rejects(copyBundleArtifacts(produced, output), /EEXIST/);
    await symlink("manifest.txt", join(produced, "unexpected-link"));
    await assert.rejects(copyBundleArtifacts(produced, output), /exactly the four/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log(
    "Release bundle: action/input pins, runtime payload, dependency pruning, net fallback, path exclusions and integrity checks passed"
  );
}

async function checkDependencyPruning(directory: string): Promise<void> {
  const lock: DependencyLock = {
    packages: {
      "": { dependencies: { "dbus-next": "1", "native": "1", "shared": "1" } },
      "node_modules/dbus-next": { optionalDependencies: { usocket: "1" } },
      "node_modules/native": { dependencies: { "node-gyp": "1", nan: "1", "node-addon-api": "1", bindings: "1" } },
      "node_modules/bindings": { dependencies: { shared: "1" } },
      "node_modules/shared": {},
      "node_modules/node-gyp": { dependencies: { "build-helper": "1" } },
      "node_modules/node-gyp/node_modules/build-helper": {},
      "node_modules/nan": {},
      "node_modules/node-addon-api": {},
      "node_modules/usocket": {},
      "node_modules/prettier": { dev: true },
      "node_modules/native/node_modules/dev-only": { dev: true },
    },
  };
  for (const path of Object.keys(lock.packages).filter(Boolean)) {
    await mkdir(join(directory, path), { recursive: true });
    await writeFile(
      join(directory, path, "package.json"),
      JSON.stringify({ name: path.split("/").at(-1), main: "index.js" })
    );
    await writeFile(join(directory, path, "index.js"), "module.exports = {};\n");
  }
  await writeFile(join(directory, "package.json"), "{}\n");
  await assert.rejects(assertNoDevDependencies(directory, lock), /dev-only|prettier/);
  await rm(join(directory, "node_modules/native/node_modules/dev-only"), { recursive: true });
  await assert.rejects(assertNoDevDependencies(directory, lock), /prettier/);
  await rm(join(directory, "node_modules/prettier"), { recursive: true });
  await assertNoDevDependencies(directory, lock);
  await assert.rejects(assertNoBuildDependencies(directory), /Build-only dependency/);
  await mkdir(join(directory, "runtime"));
  for (const name of ["nan", "node-addon-api"]) {
    await writeFile(join(directory, "node_modules", name, "LICENSE.md"), `fixture ${name} license\n`);
  }
  await preserveAddonLicenses(directory, join(directory, "runtime"));
  await mkdir(join(directory, "node_modules/.bin"));
  await symlink("../node-gyp/bin/node-gyp.js", join(directory, "node_modules/.bin/node-gyp"));
  await pruneRuntimeDependencies(directory, lock);
  assertUsocketUnavailable(directory);
  const retained = await readdir(join(directory, "node_modules"));
  assert.deepEqual(retained.sort(), ["bindings", "dbus-next", "native", "shared"]);
  assert.equal(await readFile(join(directory, "node_modules/shared/index.js"), "utf8"), "module.exports = {};\n");
  await assertNoDevDependencies(directory, lock);
  await assertNoBuildDependencies(directory);
  assert.match(await readFile(join(directory, "runtime/addon-licenses.txt"), "utf8"), /fixture nan license/);
  assert.match(await readFile(join(directory, "runtime/addon-licenses.txt"), "utf8"), /fixture node-addon-api license/);
  await mkdir(join(directory, "node_modules/usocket"));
  await writeFile(join(directory, "node_modules/usocket/package.json"), '{"main":"index.js"}');
  await writeFile(join(directory, "node_modules/usocket/index.js"), "throw new Error('broken optional transport');\n");
  assert.throws(() => assertUsocketUnavailable(directory));
}

async function checkRuntimePayload(source: string, output: string): Promise<void> {
  const directoryRoots = new Set(["src", "public", "node_modules", "runtime"]);
  await mkdir(source);
  for (const path of RUNTIME_ROOTS) {
    if (directoryRoots.has(path)) {
      await mkdir(join(source, path));
    } else {
      await writeFile(join(source, path), "runtime fixture\n");
    }
  }
  for (const script of RUNTIME_SCRIPTS) {
    await mkdir(dirname(join(source, script)), { recursive: true });
    await writeFile(join(source, script), "runtime fixture\n");
  }
  await writeFile(join(source, "scripts/check-example.ts"), "throw new Error('not a runtime script');\n");
  await mkdir(join(source, "docs"));
  await writeFile(join(source, "docs/developer.md"), "developer fixture\n");
  await writeFile(join(source, "package-lock.json"), "{}\n");
  await copyRuntimePayload(source, output);
  assert(!(await readdir(output)).includes("docs"));
  assert(!(await readdir(output)).includes("package-lock.json"));
  assert.deepEqual((await readdir(join(output, "scripts"))).sort(), ["can-capture", "update"]);
  await symlink("../package.json", join(output, "src/link"));
  await assert.rejects(assertRuntimePayload(output), /only directories and regular files/);
  await rm(join(output, "src/link"));
  await link(join(output, "package.json"), join(output, "src/hard-link"));
  await assert.rejects(assertRuntimePayload(output), /only directories and regular files/);
  await rm(join(output, "src/hard-link"));
  await writeFile(join(output, "scripts/check-example.ts"), "not allowed\n");
  await assert.rejects(assertRuntimePayload(output), /Non-runtime script/);
  await rm(join(output, "scripts/check-example.ts"));
  await mkdir(join(output, "docs"));
  await assert.rejects(assertRuntimePayload(output), /Non-runtime entry/);
}

await checkReleaseBundle();
