import { open, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureCommand } from "./commands.ts";
import { readBundleInputs } from "./inputs.ts";

export async function verifyNativeModules(bundleDirectory: string): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("Native bundle validation requires Linux ARM64");
  }
  const inputs = await readBundleInputs(bundleDirectory);
  if (process.versions.node !== inputs.node.version) {
    throw new Error(`Expected bundled Node ${inputs.node.version}; got ${process.versions.node}`);
  }
  const requireFromBundle = createRequire(join(bundleDirectory, "package.json"));
  await verifyBinary(join(bundleDirectory, "runtime/bin/node"), bundleDirectory, inputs.runtimeLibraries);
  for (const moduleName of NATIVE_MODULES) {
    const buildDirectory = join(bundleDirectory, "node_modules", moduleName, "build/Release");
    const nativeFiles = (await readdir(buildDirectory)).filter(filename => filename.endsWith(".node"));
    if (nativeFiles.length === 0) {
      throw new Error(`${moduleName}: no compiled native module`);
    }
    for (const filename of nativeFiles) {
      const modulePath = join(buildDirectory, filename);
      await verifyBinary(modulePath, bundleDirectory, inputs.runtimeLibraries);
      requireFromBundle(modulePath);
    }
    requireFromBundle(moduleName);
    console.log(`Native module loads: ${moduleName} (${nativeFiles.join(", ")})`);
  }
}

export const NATIVE_MODULES = ["socketcan", "better-sqlite3", "spi-device", "usocket"] as const;

export function validateArm64Elf(header: Uint8Array, name: string): void {
  if (
    header.length < 20 ||
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header[18] !== 183 ||
    header[19] !== 0
  ) {
    throw new Error(`${name} must be a little-endian ARM64 ELF binary`);
  }
}

async function verifyBinary(path: string, directory: string, allowedLibraries: string[]): Promise<void> {
  const binary = await open(path, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await binary.read(header, 0, header.length, 0);
    validateArm64Elf(header.subarray(0, bytesRead), path);
  } finally {
    await binary.close();
  }
  const libraries = await captureCommand("ldd", [path], { cwd: directory });
  if (/not found/.test(libraries)) {
    throw new Error(`Unresolved system library for ${path}: ${libraries}`);
  }
  for (const match of libraries.matchAll(/(?:=>\s+)?(\/\S+)/g)) {
    if (!allowedLibraries.includes(basename(match[1]))) {
      throw new Error(`${path} needs an unlisted system library: ${match[1]}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyNativeModules(resolve(process.argv[2] ?? "."));
}
