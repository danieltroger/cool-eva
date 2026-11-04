import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishRelease } from "../release/publish.ts";
import { hashFile } from "../release/files.ts";
import type { ReleaseMetadata } from "../release/manifest.ts";

export async function checkPublicationOrder(directory: string, metadata: ReleaseMetadata): Promise<void> {
  await mkdir(directory);
  for (const name of [
    "bundle.tar.zst",
    "install.sh",
    "tested-os-packages.txt",
    "installed-os-packages.txt",
    "qemu-receipt.txt",
  ]) {
    await writeFile(join(directory, name), `synthetic ${name}\n`);
  }
  await writeFile(join(directory, "release.json"), JSON.stringify(metadata));
  await writeFile(
    join(directory, "manifest.txt"),
    `release=${metadata.release}\nsha256=${await hashFile(join(directory, "bundle.tar.zst"))}\n`
  );
  await writeFile(join(directory, "qemu-result.json"), JSON.stringify({ ok: true, release: metadata.release }));
  const calls: string[][] = [];
  await publishRelease(
    directory,
    {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "danieltroger/cool-eva",
      GITHUB_SHA: metadata.commit,
      GITHUB_REF: "refs/heads/main",
    },
    async arguments_ => {
      calls.push(arguments_);
      if (arguments_[1] === "view") {
        throw Object.assign(new Error("release not found"), { stderr: "release not found\n" });
      }
      return "";
    }
  );
  const uploads = calls.filter(
    arguments_ => arguments_[1] === "upload" && arguments_[2] === `cool-eva-${metadata.release}`
  );
  assert.equal(uploads.length, 8);
  assert.equal(uploads.at(-1)![3], join(directory, "manifest.txt"));
  const publishIndex = calls.findIndex(arguments_ => arguments_[1] === "edit" && arguments_.includes("--draft=false"));
  assert(publishIndex > calls.indexOf(uploads.at(-1)!));
  assert(calls[publishIndex].includes("--latest=true"));
  assert.equal(calls.at(-1)![2], "cool-eva-channels");
  assert(calls.at(-1)![3].endsWith("/main.txt"));
}
