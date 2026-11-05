import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { builderCacheKey, BUILDER_RECIPE, prepareBuilderInputs } from "./cache.ts";
import { readBundleInputs } from "./inputs.ts";

export async function checkBuilderCacheKey(directory: string, repository: string): Promise<void> {
  const root = join(directory, "cache-key-source");
  const recipe = join(root, "scripts/release");
  await mkdir(recipe, { recursive: true });
  const inputs = await readBundleInputs(repository);
  const helper = await readFile(join(repository, "scripts/release/builder-cache.sh"), "utf8");
  const downloads = helper.split("\n").filter(line => line.includes("apt-helper") && line.includes("download-file"));
  assert.equal(downloads.length, 2);
  for (const download of downloads) {
    assert.match(download, /Acquire::Retries=5\s+download-file/, "Cold archive fetch keeps five network retries");
  }
  const tools = await readFile(join(repository, "scripts/install-check/setup-tools.sh"), "utf8");
  const qemuVersion = /^qemu_version=([\d.]+)$/m.exec(tools)?.[1];
  const slirpVersion = /^slirp_version=([\d.]+)$/m.exec(tools)?.[1];
  assert(qemuVersion);
  assert(slirpVersion);
  const workflow = await readFile(join(repository, ".github/workflows/release-bundle.yml"), "utf8");
  const sourceCachePaths = [...workflow.matchAll(/^\s+(dist\/qemu-tools\/\S+)$/gm)].map(match => match[1]);
  assert.deepEqual(
    sourceCachePaths,
    Array.from({ length: 4 }, () => [
      `dist/qemu-tools/qemu-${qemuVersion}.tar.xz`,
      `dist/qemu-tools/libslirp-v${slirpVersion}.tar.gz`,
    ]).flat(),
    "Every source cache uses only the two exact pinned tarball names"
  );
  await writeFile(join(recipe, "inputs.json"), JSON.stringify(inputs));
  for (const file of BUILDER_RECIPE) {
    await copyFile(join(repository, "scripts/release", file), join(recipe, file));
  }
  const key = await builderCacheKey(root);
  assert.equal(key, await builderCacheKey(repository));
  assert.match(key, /^builder-v1-arm64-\d{8}T\d{6}Z-[a-f0-9]{64}$/);
  for (const file of ["builder-packages.txt", "builder-repositories.sha256", "builder-cache.sh", "Dockerfile"]) {
    const path = join(recipe, file);
    const original = await readFile(path);
    await appendFile(path, "\nchanged\n");
    assert.notEqual(await builderCacheKey(root), key, file);
    await writeFile(path, original);
  }
  for (const document of [
    { ...inputs, builder: { ...inputs.builder, aptSnapshot: "20261026T000000Z" } },
    { ...inputs, builder: { ...inputs.builder, image: `debian:trixie-slim@sha256:${"a".repeat(64)}` } },
    { ...inputs, node: { ...inputs.node, sha256: "a".repeat(64) } },
  ]) {
    await writeFile(join(recipe, "inputs.json"), JSON.stringify(document));
    assert.notEqual(await builderCacheKey(root), key);
  }
  const poisoned = join(directory, "poisoned-node-cache");
  await mkdir(poisoned);
  await writeFile(join(poisoned, "node.tar.xz"), "wrong cached runtime");
  await assert.rejects(prepareBuilderInputs(repository, poisoned, "verify"), /pinned SHA-256/);
  console.log("Builder cache key binds exact roots, snapshot, base image, metadata pins, recipe and Node hash.");
}
