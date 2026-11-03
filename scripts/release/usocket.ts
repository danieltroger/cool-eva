import { createHash } from "node:crypto";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./commands.ts";

export async function prepareUsocket(sourceDirectory: string): Promise<void> {
  const moduleDirectory = join(sourceDirectory, "node_modules/usocket");
  const entryPath = join(moduleDirectory, "index.js");
  const source = await readFile(entryPath, "utf8");
  if (
    createHash("sha256").update(source).digest("hex") !==
    "a56f3d47be43a5ed9b62f595b00aef2336c99496312142b699031860a77a3338"
  ) {
    throw new Error("usocket source changed: review its Node compatibility patch before shipping");
  }
  const extraDirectory = join(sourceDirectory, "scripts/release/usocket-runtime");
  await runCommand(
    "/opt/node/bin/npm",
    ["ci", "--prefix", extraDirectory, "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: sourceDirectory,
      env: { ...process.env, npm_config_cache: "/tmp/cool-eva-npm-cache" },
    }
  );
  for (const name of ["debug", "ms"]) {
    await cp(join(extraDirectory, "node_modules", name), join(moduleDirectory, "node_modules", name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  await writeFile(entryPath, patchUsocketSource(source));
  await rm(join(extraDirectory, "node_modules"), { recursive: true });
}

export function patchUsocketSource(source: string): string {
  const utilImport = "var util = require('util');";
  const errorCheck = "util.isError(r)";
  if (source.split(utilImport).length !== 2 || source.split(errorCheck).length !== 2) {
    throw new Error("Unexpected usocket compatibility patch anchors");
  }
  return source
    .replace(utilImport, utilImport + "\nvar isNativeError = require('node:util/types').isNativeError;")
    .replace(errorCheck, "isNativeError(r)");
}
