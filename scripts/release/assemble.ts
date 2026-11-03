import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureCommand, runCommand } from "./commands.ts";
import { hashFile, writeFileInventory } from "./files.ts";
import { readBundleInputs } from "./inputs.ts";
import { createReleaseMetadata, renderReleaseManifest } from "./manifest.ts";
import { NATIVE_MODULES, selectNativeBinaries, verifyNativeModules } from "./native.ts";
import {
  assertNoDevDependencies,
  assertNoBuildDependencies,
  preserveAddonLicenses,
  pruneRuntimeDependencies,
  readDependencyLock,
  type DependencyLock,
} from "./dependencies.ts";
import { assertRuntimePayload, copyRuntimePayload } from "./payload.ts";

export async function assembleBundle(sourceDirectory: string, outputDirectory: string): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("Build the release in the pinned Linux ARM64 container");
  }
  const inputs = await readBundleInputs(sourceDirectory);
  if (process.versions.node !== inputs.node.version) {
    throw new Error(`Build requires Node ${inputs.node.version}`);
  }
  const metadata = createReleaseMetadata(inputs, {
    commit: requiredEnvironment("BUNDLE_COMMIT"),
    channel: requiredEnvironment("BUNDLE_CHANNEL"),
    branch: requiredEnvironment("BUNDLE_BRANCH"),
    epoch: requiredEnvironment("SOURCE_DATE_EPOCH"),
  });
  await mkdir(outputDirectory, { recursive: true });
  const options = { cwd: sourceDirectory, env: { ...process.env, npm_config_cache: "/tmp/cool-eva-npm-cache" } };
  const dependencyLock = await readDependencyLock(sourceDirectory);
  assertKnownBuildScripts(dependencyLock);
  // Optional native failures must fail the release, rather than npm pruning a dependency.
  await runCommand(
    "/opt/node/bin/npm",
    ["ci", "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund"],
    options
  );
  await assertNoDevDependencies(sourceDirectory, dependencyLock);
  for (const moduleName of NATIVE_MODULES) {
    await runCommand(
      process.execPath,
      [
        "node_modules/node-gyp/bin/node-gyp.js",
        "rebuild",
        `--directory=node_modules/${moduleName}`,
        "--nodedir=/opt/node",
        "--python=/usr/bin/python3",
      ],
      {
        ...options,
        env: {
          ...options.env,
          CFLAGS: "-march=armv8-a -mtune=cortex-a53",
          CXXFLAGS: "-march=armv8-a -mtune=cortex-a53",
        },
      }
    );
  }
  const runtimeDirectory = join(sourceDirectory, "runtime");
  await mkdir(join(runtimeDirectory, "bin"), { recursive: true });
  await copyFile("/opt/node/bin/node", join(runtimeDirectory, "bin/node"));
  await copyFile("/opt/node/LICENSE", join(runtimeDirectory, "LICENSE"));
  const packageList = join(sourceDirectory, "tested-os-packages.txt");
  const packageListUrl = inputs.testedImage.url.replace(/\.img\.xz$/, ".info");
  await runCommand("curl", ["--fail", "--show-error", "--location", packageListUrl, "--output", packageList], options);
  if ((await hashFile(packageList)) !== inputs.testedImage.packagesSha256) {
    throw new Error("The tested Raspberry Pi OS package list did not match its pinned checksum");
  }
  await writeFile(
    join(sourceDirectory, "build-os-packages.txt"),
    await captureCommand("dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\n"], options)
  );
  await writeFile(join(sourceDirectory, "release.json"), JSON.stringify(metadata, null, 2) + "\n");
  await keepNativeBinaries(sourceDirectory);
  await preserveAddonLicenses(sourceDirectory, runtimeDirectory);
  await pruneRuntimeDependencies(sourceDirectory, dependencyLock);
  await assertNoBuildDependencies(sourceDirectory);
  await verifyNativeModules(sourceDirectory, inputs);
  await runCommand(
    join(runtimeDirectory, "bin/node"),
    [
      "--eval",
      "const Database = require('better-sqlite3'); const database = new Database(':memory:'); if (database.prepare('select 42 as value').get().value !== 42) { throw new Error('SQLite smoke check failed'); } database.close();",
    ],
    options
  );
  const payloadDirectory = await mkdtemp("/work/payload-");
  await copyRuntimePayload(sourceDirectory, payloadDirectory);
  await writeFileInventory(payloadDirectory);

  const archive = join(outputDirectory, "bundle.tar.zst");
  await runCommand(
    "tar",
    [
      "--sort=name",
      "--format=posix",
      `--mtime=@${metadata.sourceDateEpoch}`,
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--pax-option=delete=atime,delete=ctime",
      "--use-compress-program=zstd -T1 -10",
      "-cf",
      archive,
      "-C",
      payloadDirectory,
      ".",
    ],
    options
  );
  const extractedDirectory = await mkdtemp("/work/extracted-");
  await runCommand("tar", ["--zstd", "-xf", archive, "-C", extractedDirectory], options);
  const extractedOptions = {
    cwd: extractedDirectory,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/nonexistent", NODE_PATH: "" },
  };
  await runCommand(
    join(extractedDirectory, "runtime/bin/node"),
    [
      "--experimental-strip-types",
      join(sourceDirectory, "scripts/release/native.ts"),
      extractedDirectory,
      sourceDirectory,
    ],
    extractedOptions
  );
  await assertRuntimePayload(extractedDirectory);
  await assertNoDevDependencies(extractedDirectory, dependencyLock);
  await assertNoBuildDependencies(extractedDirectory);
  await runCommand("sha256sum", ["--check", "--strict", "--quiet", "files.sha256"], extractedOptions);
  await copyFile(join(sourceDirectory, "release.json"), join(outputDirectory, "release.json"));
  await copyFile(packageList, join(outputDirectory, "tested-os-packages.txt"));
  await writeFile(
    join(outputDirectory, "manifest.txt"),
    renderReleaseManifest(metadata, await hashFile(archive), (await stat(archive)).size)
  );
  console.log(`Built and checked ${metadata.release}; manifest written last`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing build input ${name}`);
  }
  return value;
}

async function keepNativeBinaries(directory: string): Promise<void> {
  for (const moduleName of NATIVE_MODULES) {
    const buildDirectory = join(directory, "node_modules", moduleName, "build");
    const releaseDirectory = join(buildDirectory, "Release");
    const nativeFiles = selectNativeBinaries(moduleName, await readdir(releaseDirectory));
    const savedDirectory = await mkdtemp("/work/native-");
    for (const filename of nativeFiles) {
      await copyFile(join(releaseDirectory, filename), join(savedDirectory, filename));
    }
    // node-gyp leaves an absolute Python symlink and object files; neither belongs on the Pi.
    await rm(buildDirectory, { recursive: true });
    await mkdir(releaseDirectory, { recursive: true });
    for (const filename of nativeFiles) {
      await copyFile(join(savedDirectory, filename), join(releaseDirectory, filename));
    }
    await rm(savedDirectory, { recursive: true });
  }
}

function assertKnownBuildScripts(lockfile: DependencyLock): void {
  const knownPaths = new Set(NATIVE_MODULES.map(moduleName => `node_modules/${moduleName}`));
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    // Intentionally excluded optional transport; docs/pi-install-prerequisites.md documents the net fallback.
    if (path === "node_modules/usocket") {
      continue;
    }
    if (entry.hasInstallScript && !entry.dev && !knownPaths.has(path)) {
      throw new Error(`Production lifecycle script needs an explicit release build step: ${path}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await assembleBundle(process.cwd(), resolve(process.argv[2] ?? "/work/output"));
}
