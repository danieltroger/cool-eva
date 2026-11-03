import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyBundleArtifacts } from "./release/build.ts";
import { hashFile, selectSourcePaths, validateArchivePath, writeFileInventory } from "./release/files.ts";
import { parseBundleInputs, readBundleInputs, validateBuildIdentity } from "./release/inputs.ts";
import { createReleaseMetadata, renderReleaseManifest } from "./release/manifest.ts";
import { validateArm64Elf } from "./release/native.ts";

export async function checkReleaseBundle(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const inputs = await readBundleInputs(root);
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
    "docs/setup.md",
    "ride-logs/trip.celog",
    "ride-log-key.private.pem",
    ".env",
    ".claude/notes.txt",
    "map/node_modules/cache",
  ]);
  assert(selected.includes("public/app.js"));
  assert(selected.includes("docs/setup.md"));
  assert.equal(selected.length, required.length + 2);
  assert.throws(() => selectSourcePaths(required.filter(path => path !== "src/index.ts")));
  for (const path of [
    "../outside",
    "/etc/passwd",
    "src/../outside",
    "src/one\ntwo",
    "src/key.private.pem",
    "docs/ride-logs/trip.celog",
    "node_modules/one/.git/config",
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

  const temporaryParent = join(root, ".preview-shots");
  await mkdir(temporaryParent, { recursive: true });
  const directory = await mkdtemp(join(temporaryParent, "release-check-"));
  try {
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
    "Release bundle: pinned inputs, source boundary, ARM64 rejection, manifest and file-integrity checks passed"
  );
}

await checkReleaseBundle();
