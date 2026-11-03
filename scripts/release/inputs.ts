import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readBundleInputs(sourceDirectory: string): Promise<BundleInputs> {
  const document: unknown = JSON.parse(await readFile(join(sourceDirectory, "scripts/release/inputs.json"), "utf8"));
  return parseBundleInputs(document);
}

export interface BundleInputs {
  format: 1;
  node: { version: string; sha256: string };
  builder: { image: string; aptSnapshot: string };
  testedImage: { url: string; sha256: string; packagesSha256: string };
  runtimeLibraries: string[];
}

export function parseBundleInputs(document: unknown): BundleInputs {
  const root = record(document, "inputs");
  if (root.format !== 1) {
    throw new Error("Unsupported bundle inputs format");
  }
  const node = record(root.node, "node");
  const builder = record(root.builder, "builder");
  const testedImage = record(root.testedImage, "testedImage");
  const version = text(node.version, "node.version", /^24\.\d+\.\d+$/);
  const imageUrl = text(
    testedImage.url,
    "testedImage.url",
    /^https:\/\/downloads\.raspberrypi\.com\/raspios_lite_arm64\/images\/raspios_lite_arm64-\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}-raspios-trixie-arm64-lite\.img\.xz$/
  );
  if (!Array.isArray(root.runtimeLibraries) || root.runtimeLibraries.length === 0) {
    throw new Error("runtimeLibraries must name the permitted system libraries");
  }
  return {
    format: 1,
    node: { version, sha256: text(node.sha256, "node.sha256", /^[a-f0-9]{64}$/) },
    builder: {
      image: text(builder.image, "builder.image", /^debian:trixie-slim@sha256:[a-f0-9]{64}$/),
      aptSnapshot: text(builder.aptSnapshot, "builder.aptSnapshot", /^\d{8}T\d{6}Z$/),
    },
    testedImage: {
      url: imageUrl,
      sha256: text(testedImage.sha256, "testedImage.sha256", /^[a-f0-9]{64}$/),
      packagesSha256: text(testedImage.packagesSha256, "testedImage.packagesSha256", /^[a-f0-9]{64}$/),
    },
    runtimeLibraries: root.runtimeLibraries.map((library, index) =>
      text(library, `runtimeLibraries[${index}]`, /^[a-zA-Z0-9.+_-]+\.so(?:\.[0-9]+)*$/)
    ),
  };
}

export function validateBuildIdentity(commit: string, channel: string, branch: string, epoch: string): void {
  text(commit, "commit", /^[a-f0-9]{40}$/);
  text(channel, "channel", /^[a-z][a-z0-9-]{0,47}$/);
  text(branch, "branch", /^[a-zA-Z0-9_./-]{1,200}$/);
  text(epoch, "source epoch", /^[1-9][0-9]{8,10}$/);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a record`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} is not pinned or contains unsupported characters`);
  }
  return value;
}
