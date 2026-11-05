import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBuilderImage, OFFLINE_NETWORK_ARGUMENTS } from "./cache.ts";
import { readBundleInputs } from "./inputs.ts";

export async function proveBuilderCache(repository: string, cache: string, sources: string): Promise<void> {
  await buildBuilderImage(repository, cache, "cool-eva-builder:offline-proof");
  await assert.rejects(
    promisify(execFile)("docker", [
      "run",
      "--rm",
      "--platform=linux/arm64",
      ...OFFLINE_NETWORK_ARGUMENTS,
      "cool-eva-builder:offline-proof",
      "curl",
      "--fail",
      "--show-error",
      "--silent",
      "--noproxy",
      "*",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      "--output",
      "/dev/null",
      "https://deb.debian.org/debian/README",
    ]),
    /curl: \((6|7|28)\)/,
    "Offline container must refuse an attempted fetch"
  );
  console.log("Offline positive control: attempted fetch refused inside network=none container.");
  const inputs = await readBundleInputs(repository);
  for (const [name, mutation, expected] of [
    [
      "changed-deb",
      `${FLIP_FIRST_BYTE} archive=$(find /tmp/cache/archives -type f -name '*.deb' | sort | head -n 1); flip "$archive"`,
      /FAILED/,
    ],
    [
      "changed-index",
      `${FLIP_FIRST_BYTE} flip /tmp/cache/repository/dists/trixie/main/binary-arm64/Packages`,
      /Hash Sum mismatch/i,
    ],
    ["changed-release", `${FLIP_FIRST_BYTE} flip /tmp/cache/repository/dists/trixie/InRelease`, /FAILED/],
    [
      "bad-signature",
      `sed -i 's/^Date:.*/Date: Thu, 01 Jan 2026 00:00:00 UTC/' /tmp/cache/repository/dists/trixie/InRelease
(cd /tmp/cache && sha256sum repository/dists/trixie/InRelease repository/dists/trixie-updates/InRelease) > /tmp/recipe/builder-repositories.sha256`,
      /signature|OpenPGP/i,
    ],
    [
      "extra-package",
      `archive=$(find /tmp/cache/archives -type f -name '*.deb' | sort | head -n 1); cp "$archive" /tmp/cache/archives/injected.deb`,
      /Cached package set differs/,
    ],
  ] as const) {
    let failure: unknown;
    try {
      await promisify(execFile)(
        "docker",
        [
          "run",
          "--rm",
          "--platform=linux/arm64",
          ...OFFLINE_NETWORK_ARGUMENTS,
          "--volume",
          `${join(cache, "apt")}:/cache:ro`,
          "--volume",
          `${join(repository, "scripts/release")}:/recipe:ro`,
          inputs.builder.image,
          "sh",
          "-eu",
          "-c",
          `cp -a /cache /tmp/cache; cp -a /recipe /tmp/recipe; ${mutation}\nexec sh /tmp/recipe/builder-cache.sh verify /tmp/cache`,
        ],
        { maxBuffer: 16 * 1024 * 1024 }
      );
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error && "stdout" in failure && "stderr" in failure, `${name}: tampered cache accepted`);
    const output = String(failure.stdout) + String(failure.stderr);
    assert.match(output, expected, `${name}: wrong failure`);
    console.log(`Cache tamper refused: ${name}`);
    console.log(
      output
        .split("\n")
        .filter(line => expected.test(line))
        .join("\n")
    );
  }
  const fixture = await mkdtemp(join(dirname(cache), ".source-cache-proof-"));
  try {
    await mkdir(join(fixture, "bin"));
    await writeFile(
      join(fixture, "bin/curl"),
      "#!/bin/sh\necho 'Unexpected source download on cache hit' >&2\nexit 91\n",
      { mode: 0o755 }
    );
    const script = join(repository, "scripts/install-check/setup-tools.sh");
    const environment = { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH}` };
    const warm = await promisify(execFile)("sh", [script, sources, "fetch-only"], { env: environment });
    assert.match(warm.stdout, /Verified pinned source: qemu-/);
    assert.match(warm.stdout, /Verified pinned source: libslirp-/);
    console.log("Source cache hit verified with curl disabled.");
    const recipe = await readFile(script, "utf8");
    const version = /^qemu_version=([\d.]+)$/m.exec(recipe)?.[1];
    const slirpVersion = /^slirp_version=([\d.]+)$/m.exec(recipe)?.[1];
    assert(version);
    assert(slirpVersion);
    await copyFile(
      join(sources, `libslirp-v${slirpVersion}.tar.gz`),
      join(fixture, `libslirp-v${slirpVersion}.tar.gz`)
    );
    await writeFile(join(fixture, `qemu-${version}.tar.xz`), "tampered source archive");
    await assert.rejects(
      promisify(execFile)("sh", [script, fixture, "fetch-only"], { env: environment }),
      /Checksum mismatch/
    );
    console.log("Tampered source tarball refused without a network fallback.");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const FLIP_FIRST_BYTE = String.raw`flip() {
 original=$(od -An -tu1 -N1 "$1"); replacement=$(((original + 1) % 256)); octal=$(printf '%03o' "$replacement");
 printf "\\$octal" | dd of="$1" bs=1 count=1 conv=notrunc 2>/dev/null
};`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await proveBuilderCache(
    process.cwd(),
    resolve(process.argv[2] ?? "dist/release-inputs"),
    resolve(process.argv[3] ?? "dist/qemu-tools")
  );
}
