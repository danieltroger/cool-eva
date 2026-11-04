import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureCommand, runCommand } from "./commands.ts";
import { selectSourcePaths } from "./files.ts";
import { readBundleInputs, validateBuildIdentity } from "./inputs.ts";

export async function buildReleaseBundle(sourceDirectory: string, outputDirectory: string): Promise<void> {
  const outputRelative = relative(sourceDirectory, outputDirectory);
  if (!outputRelative || outputRelative === ".." || outputRelative.startsWith("../")) {
    throw new Error("Bundle output must be a subdirectory of this checkout");
  }
  const commandOptions = { cwd: sourceDirectory };
  if ((await captureCommand("git", ["status", "--porcelain", "--untracked-files=no"], commandOptions)).trim()) {
    throw new Error("Commit tracked changes first: the bundle records and builds exactly HEAD");
  }
  const commit = (await captureCommand("git", ["rev-parse", "HEAD"], commandOptions)).trim();
  const epoch = (await captureCommand("git", ["show", "-s", "--format=%ct", "HEAD"], commandOptions)).trim();
  const branch =
    process.env.BUNDLE_BRANCH ?? (await captureCommand("git", ["branch", "--show-current"], commandOptions)).trim();
  const channel = process.env.BUNDLE_CHANNEL ?? "main";
  validateBuildIdentity(commit, channel, branch, epoch);
  const inputs = await readBundleInputs(sourceDirectory);
  const trackedPaths = (await captureCommand("git", ["ls-files", "-z"], commandOptions)).split("\0").filter(Boolean);
  const sourcePaths = selectSourcePaths(trackedPaths);
  await mkdir(outputDirectory, { recursive: true });
  if ((await readdir(outputDirectory)).length !== 0) {
    throw new Error("Choose an empty output directory; existing bundle artifacts are never overwritten");
  }
  const stagingDirectory = await mkdtemp(join(outputDirectory, ".build-"));
  try {
    const stagedSource = join(stagingDirectory, "source");
    await mkdir(stagedSource);
    const sourceArchive = join(stagingDirectory, "source.tar");
    await runCommand(
      "git",
      ["archive", "--format=tar", `--output=${sourceArchive}`, commit, "--", ...sourcePaths],
      commandOptions
    );
    await runCommand("tar", ["-xf", sourceArchive, "-C", stagedSource], commandOptions);
    const builderTag = `cool-eva-builder:${commit.slice(0, 12)}`;
    await runCommand(
      "docker",
      [
        "build",
        "--platform=linux/arm64",
        "--tag",
        builderTag,
        "--file",
        "scripts/release/Dockerfile",
        "--build-arg",
        `BUILDER_IMAGE=${inputs.builder.image}`,
        "--build-arg",
        `APT_SNAPSHOT=${inputs.builder.aptSnapshot}`,
        "--build-arg",
        `NODE_VERSION=${inputs.node.version}`,
        "--build-arg",
        `NODE_SHA256=${inputs.node.sha256}`,
        "scripts/release",
      ],
      commandOptions
    );
    await runCommand(
      "docker",
      [
        "run",
        "--rm",
        "--platform=linux/arm64",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--volume",
        `${stagingDirectory}:/work`,
        "--env",
        `BUNDLE_COMMIT=${commit}`,
        "--env",
        `BUNDLE_BRANCH=${branch}`,
        "--env",
        `BUNDLE_CHANNEL=${channel}`,
        "--env",
        `SOURCE_DATE_EPOCH=${epoch}`,
        builderTag,
        "/opt/node/bin/node",
        "--experimental-strip-types",
        "scripts/release/assemble.ts",
        "/work/output",
      ],
      commandOptions
    );
    await copyBundleArtifacts(join(stagingDirectory, "output"), outputDirectory);
    console.log(`Bundle artifacts: ${outputDirectory}`);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function copyBundleArtifacts(producedDirectory: string, outputDirectory: string): Promise<void> {
  const expected = new Set(["bundle.tar.zst", "manifest.txt", "release.json", "tested-os-packages.txt"]);
  const entries = await readdir(producedDirectory, { withFileTypes: true });
  if (entries.length !== expected.size || entries.some(entry => !entry.isFile() || !expected.has(entry.name))) {
    throw new Error("Builder output must contain exactly the four regular bundle artifacts");
  }
  for (const entry of entries) {
    await copyFile(join(producedDirectory, entry.name), join(outputDirectory, entry.name), constants.COPYFILE_EXCL);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildReleaseBundle(process.cwd(), resolve(process.argv[2] ?? "dist/release"));
}
