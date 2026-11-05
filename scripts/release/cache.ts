import { appendFile, copyFile, cp, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./commands.ts";
import { hashFile } from "./files.ts";
import { readBundleInputs } from "./inputs.ts";

export async function prepareBuilderInputs(
  sourceDirectory: string,
  cacheDirectory: string,
  mode: "fetch" | "verify"
): Promise<void> {
  const inputs = await readBundleInputs(sourceDirectory);
  await mkdir(cacheDirectory, { recursive: true });
  await assertRegularTree(cacheDirectory);
  const entries = await readdir(cacheDirectory);
  const nodeArchive = join(cacheDirectory, "node.tar.xz");
  if (!entries.includes("node.tar.xz") && mode === "fetch") {
    await runCommand(
      "curl",
      [
        "--fail",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--output",
        nodeArchive + ".part",
        `https://nodejs.org/dist/v${inputs.node.version}/node-v${inputs.node.version}-linux-arm64.tar.xz`,
      ],
      { cwd: sourceDirectory }
    );
    await rename(nodeArchive + ".part", nodeArchive);
  }
  if ((await hashFile(nodeArchive)) !== inputs.node.sha256) {
    throw new Error("Cached Node archive does not match the pinned SHA-256");
  }
  const aptCache = join(cacheDirectory, "apt");
  await mkdir(aptCache, { recursive: true });
  await runCommand(
    "docker",
    [
      "run",
      "--rm",
      "--platform=linux/arm64",
      ...(mode === "verify" ? OFFLINE_NETWORK_ARGUMENTS : []),
      "--volume",
      `${join(sourceDirectory, "scripts/release")}:/recipe:ro`,
      "--volume",
      `${aptCache}:/cache${mode === "verify" ? ":ro" : ""}`,
      "--env",
      `APT_SNAPSHOT=${inputs.builder.aptSnapshot}`,
      "--env",
      `CACHE_OWNER=${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      inputs.builder.image,
      "sh",
      "/recipe/builder-cache.sh",
      mode,
      "/cache",
    ],
    { cwd: sourceDirectory }
  );
  await assertRegularTree(cacheDirectory);
  if ((await readdir(cacheDirectory)).some(entry => !["apt", "node.tar.xz"].includes(entry))) {
    throw new Error("Unexpected file in builder inputs cache");
  }
  console.log(`Builder inputs ${mode === "verify" ? "verified offline (network=none)" : "fetched and verified"}`);
}

export async function builderCacheKey(sourceDirectory: string): Promise<string> {
  const inputs = await readBundleInputs(sourceDirectory);
  const recipe = await Promise.all(
    BUILDER_RECIPE.map(async file => ({
      file,
      sha256: await hashFile(join(sourceDirectory, "scripts/release", file)),
    }))
  );
  const digest = createHash("sha256")
    .update(JSON.stringify({ builder: inputs.builder, node: inputs.node, recipe }))
    .digest("hex");
  return `builder-v1-arm64-${inputs.builder.aptSnapshot}-${digest}`;
}

export async function buildBuilderImage(sourceDirectory: string, cacheDirectory: string, tag: string): Promise<void> {
  await prepareBuilderInputs(sourceDirectory, cacheDirectory, "verify");
  const inputs = await readBundleInputs(sourceDirectory);
  const context = await mkdtemp(join(dirname(cacheDirectory), ".builder-context-"));
  try {
    for (const file of BUILDER_RECIPE) {
      await copyFile(join(sourceDirectory, "scripts/release", file), join(context, file));
    }
    await cp(cacheDirectory, join(context, "inputs"), { recursive: true, dereference: false });
    await runCommand(
      "docker",
      [
        "build",
        "--no-cache",
        ...OFFLINE_NETWORK_ARGUMENTS,
        "--platform=linux/arm64",
        "--tag",
        tag,
        "--build-arg",
        `BUILDER_IMAGE=${inputs.builder.image}`,
        "--build-arg",
        `NODE_SHA256=${inputs.node.sha256}`,
        context,
      ],
      { cwd: sourceDirectory }
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export const BUILDER_RECIPE = [
  "Dockerfile",
  "builder-cache.sh",
  "builder-packages.txt",
  "builder-repositories.sha256",
  "cache.ts",
];

export const OFFLINE_NETWORK_ARGUMENTS = ["--network=none"] as const;

async function assertRegularTree(directory: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error("Builder cache must be a real directory");
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await assertRegularTree(join(directory, entry.name));
    } else if (!entry.isFile()) {
      throw new Error("Builder cache contains a link or special file");
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.cwd();
  const [mode, requestedDirectory] = process.argv.slice(2);
  const directory = resolve(requestedDirectory ?? "dist/release-inputs");
  if (mode === "key") {
    const key = await builderCacheKey(source);
    const sourcesKey = `qemu-source-v1-${await hashFile(join(source, "scripts/install-check/setup-tools.sh"))}`;
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `key=${key}\nsources-key=${sourcesKey}\n`);
    }
    console.log(key);
  } else if (mode === "fetch" || mode === "verify") {
    await prepareBuilderInputs(source, directory, mode);
  } else if (mode === "image") {
    await buildBuilderImage(source, directory, "cool-eva-builder:offline-proof");
  } else {
    throw new Error("Usage: cache.ts key|fetch|verify|image [CACHE_DIRECTORY]");
  }
}
