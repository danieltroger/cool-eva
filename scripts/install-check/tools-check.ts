import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export async function checkQemuSlirp(directory: string, repository: string): Promise<void> {
  const dependenciesFile = join(directory, "qemu-dependencies.json");
  const optionsFile = join(directory, "qemu-options.json");
  const expectedLibrary = "/synthetic/pinned-slirp/lib/libslirp.a";
  const dependency = { name: "slirp", type: "pkgconfig", version: "4.9.7", link_args: [expectedLibrary] };
  for (const [name, dependencies, wrapMode, expectedError] of [
    ["pinned", [dependency], "nofallback", null],
    ["subproject", [{ ...dependency, type: "internal" }], "nofallback", /through pkg-config/],
    ["version", [{ ...dependency, version: "4.9.8" }], "nofallback", /pinned version/],
    [
      "archive",
      [{ ...dependency, link_args: ["/synthetic/unpinned/libslirp.a"] }],
      "nofallback",
      /pinned libslirp archive/,
    ],
    ["missing", [], "nofallback", /exactly one/],
    ["duplicate", [dependency, dependency], "nofallback", /exactly one/],
    ["fallback", [dependency], "default", /fallbacks must be disabled/],
  ] as const) {
    await writeFile(dependenciesFile, JSON.stringify(dependencies));
    await writeFile(optionsFile, JSON.stringify([{ name: "wrap_mode", value: wrapMode }]));
    const verification = promisify(execFile)("python3", [
      join(repository, "scripts/install-check/verify-slirp.py"),
      dependenciesFile,
      optionsFile,
      "4.9.7",
      expectedLibrary,
    ]);
    if (expectedError) {
      await assert.rejects(verification, expectedError, name);
    } else {
      assert.match((await verification).stdout, /QEMU libslirp verified: pkg-config 4\.9\.7/);
    }
  }
  console.log(
    "QEMU libslirp: pinned pkg-config archive required; subprojects, version/path drift and fallbacks refused."
  );
}
