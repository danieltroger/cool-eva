import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RUNTIME_SCRIPTS } from "./files.ts";

export async function copyRuntimePayload(sourceDirectory: string, payloadDirectory: string): Promise<void> {
  await mkdir(payloadDirectory, { recursive: true });
  for (const path of RUNTIME_ROOTS) {
    await cp(join(sourceDirectory, path), join(payloadDirectory, path), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  for (const path of RUNTIME_SCRIPTS) {
    await mkdir(dirname(join(payloadDirectory, path)), { recursive: true });
    await cp(join(sourceDirectory, path), join(payloadDirectory, path), { errorOnExist: true, force: false });
  }
  await assertRuntimePayload(payloadDirectory);
}

export const RUNTIME_ROOTS = [
  "src",
  "public",
  "node_modules",
  "runtime",
  "package.json",
  "LICENSE",
  "release.json",
  "tested-os-packages.txt",
  "build-os-packages.txt",
] as const;

export async function assertRuntimePayload(directory: string): Promise<void> {
  const allowedRoots = new Set<string>([...RUNTIME_ROOTS, "files.sha256", "scripts"]);
  for (const path of await readdir(directory)) {
    if (!allowedRoots.has(path)) {
      throw new Error(`Non-runtime entry in bundle: ${path}`);
    }
  }
  for (const path of await scriptFiles(directory, "scripts")) {
    if (!RUNTIME_SCRIPTS.some(script => script === path)) {
      throw new Error(`Non-runtime script in bundle: ${path}`);
    }
  }
}

async function scriptFiles(directory: string, relativeDirectory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, relativeDirectory), { withFileTypes: true })) {
    const path = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await scriptFiles(directory, path)));
    } else {
      files.push(path);
    }
  }
  return files;
}
