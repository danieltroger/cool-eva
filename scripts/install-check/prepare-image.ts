import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { runCommand } from "../release/commands.ts";
import { hashFile } from "../release/files.ts";
import type { BundleInputs } from "../release/inputs.ts";

export async function prepareImage(cache: string, image: BundleInputs["testedImage"]): Promise<string> {
  await mkdir(cache, { recursive: true });
  const compressed = join(cache, "lite.img.xz");
  if (!(await present(compressed))) {
    await runCommand(
      "curl",
      [
        "--fail",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--retry",
        "2",
        "--output",
        compressed + ".part",
        image.url,
      ],
      { cwd: process.cwd() }
    );
    await rename(compressed + ".part", compressed);
  }
  if ((await hashFile(compressed)) !== image.sha256) {
    throw new Error("Pinned image checksum mismatch; use a clean cache directory");
  }
  const raw = join(cache, "lite.img");
  const identity = join(cache, "lite.img.sha256");
  if ((await present(raw)) && (await present(identity)) && (await readFile(identity, "utf8")).trim() === image.sha256) {
    return raw;
  }
  const decompressor = spawn("xz", ["--decompress", "--stdout"], { stdio: ["pipe", "pipe", "inherit"] });
  const exit = new Promise<void>((resolve, reject) => {
    decompressor.once("error", reject);
    decompressor.once("exit", code => (code === 0 ? resolve() : reject(new Error("Image decompression failed"))));
  });
  await Promise.all([
    pipeline(createReadStream(compressed), decompressor.stdin),
    pipeline(decompressor.stdout, createWriteStream(raw + ".part", { flags: "w" })),
    exit,
  ]);
  await rename(raw + ".part", raw);
  await writeFile(identity, image.sha256 + "\n");
  return raw;
}

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
