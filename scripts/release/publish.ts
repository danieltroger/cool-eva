import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureCommand } from "./commands.ts";
import { hashFile } from "./files.ts";
import type { ReleaseMetadata } from "./manifest.ts";

export async function publishRelease(
  directory: string,
  environment = process.env,
  execute: GithubCommand = github
): Promise<void> {
  const metadata = JSON.parse(await readFile(join(directory, "release.json"), "utf8")) as ReleaseMetadata;
  assertPublicationAllowed(metadata, environment);
  const receipt = JSON.parse(await readFile(join(directory, "qemu-result.json"), "utf8")) as {
    ok: boolean;
    release: string;
  };
  if (receipt.ok !== true || receipt.release !== metadata.release) {
    throw new Error("No successful QEMU installer gate for this release");
  }
  const manifest = await readFile(join(directory, "manifest.txt"), "utf8");
  if (
    !manifest.includes(`release=${metadata.release}\n`) ||
    !manifest.includes(`sha256=${await hashFile(join(directory, "bundle.tar.zst"))}\n`)
  ) {
    throw new Error("Publication archive does not match its manifest");
  }
  const tag = `cool-eva-${metadata.release}`;
  const files = [
    "bundle.tar.zst",
    "release.json",
    "install.sh",
    "tested-os-packages.txt",
    "installed-os-packages.txt",
    "qemu-receipt.txt",
    "qemu-result.json",
    "manifest.txt",
  ];
  const temporary = await mkdtemp(join(directory, ".publish-"));
  const existing = await releaseState(tag, execute);
  if (existing?.isDraft === false) {
    for (const name of files) {
      await execute(["release", "download", tag, "--pattern", name, "--dir", temporary]);
      if ((await hashFile(join(temporary, name))) !== (await hashFile(join(directory, name)))) {
        throw new Error(`Published assets are immutable; refusing to change ${tag}/${name}`);
      }
    }
  } else {
    if (!existing) {
      const notes = join(temporary, "notes.txt");
      await writeFile(
        notes,
        "From Daniel’s AI agent. Self-contained ARM64 bundle and installer; pinned-image QEMU installation, native, migration and rollback checks must pass before publication. Older release assets are retained.\n"
      );
      await execute([
        "release",
        "create",
        tag,
        "--draft",
        "--target",
        metadata.commit,
        "--title",
        `Cool Eva ${metadata.release}`,
        "--notes-file",
        notes,
      ]);
    }
    // The manifest is the completion marker. The release stays draft until it exists.
    for (const name of files) {
      await execute(["release", "upload", tag, join(directory, name), "--clobber"]);
    }
    await execute([
      "release",
      "edit",
      tag,
      "--draft=false",
      `--prerelease=${metadata.channel !== "main"}`,
      `--latest=${metadata.channel === "main"}`,
    ]);
  }
  const channels = await releaseState("cool-eva-channels", execute);
  if (!channels) {
    await execute([
      "release",
      "create",
      "cool-eva-channels",
      "--prerelease",
      "--latest=false",
      "--target",
      metadata.commit,
      "--title",
      "Cool Eva update channels",
      "--notes",
      "From Daniel’s AI agent. Mutable channel pointers; immutable release assets are retained.",
    ]);
  }
  const pointer = join(temporary, `${metadata.channel}.txt`);
  await writeFile(pointer, tag + "\n");
  await execute(["release", "upload", "cool-eva-channels", pointer, "--clobber"]);
  console.log(`Published ${tag}; ${metadata.channel} pointer written last.`);
}

export function assertPublicationAllowed(
  metadata: ReleaseMetadata,
  environment: Readonly<Record<string, string | undefined>>
): void {
  if (
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REPOSITORY !== "danieltroger/cool-eva" ||
    environment.GITHUB_SHA !== metadata.commit
  ) {
    throw new Error("Only an explicitly dispatched upstream build can publish; PR/fork builds never publish");
  }
  if (
    !/^(main|branch-[a-z0-9.-]+)$/.test(metadata.channel) ||
    metadata.release !== `${metadata.channel}-${metadata.commit}` ||
    !/^[a-f0-9]{40}$/.test(metadata.commit)
  ) {
    throw new Error("Unsafe release publication identity");
  }
  if (metadata.channel === "main" && (environment.GITHUB_REF !== "refs/heads/main" || metadata.branch !== "main")) {
    throw new Error("Main-channel releases can only be published from main");
  }
}

export type GithubCommand = (arguments_: string[]) => Promise<string>;

async function github(arguments_: string[]): Promise<string> {
  return captureCommand("gh", [...arguments_, "--repo", "danieltroger/cool-eva"], { cwd: process.cwd() });
}

async function releaseState(tag: string, execute: GithubCommand): Promise<{ isDraft: boolean } | null> {
  try {
    return JSON.parse(await execute(["release", "view", tag, "--json", "isDraft"])) as { isDraft: boolean };
  } catch (error) {
    if (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      /release not found/i.test(error.stderr)
    ) {
      console.log(`Release ${tag} does not exist yet.`);
      return null;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publishRelease(resolve(process.argv[2] ?? "dist/release"));
}
