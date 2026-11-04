import { validateBuildIdentity, type BundleInputs } from "./inputs.ts";
import { SETTINGS_SCHEMA_VERSION } from "../../src/settings/schema.ts";

export function createReleaseMetadata(inputs: BundleInputs, identity: BuildIdentity): ReleaseMetadata {
  validateBuildIdentity(identity.commit, identity.channel, identity.branch, identity.epoch);
  return {
    format: 1,
    release: `${identity.channel}-${identity.commit}`,
    commit: identity.commit,
    branch: identity.branch,
    channel: identity.channel,
    sourceDateEpoch: Number(identity.epoch),
    platform: "linux-arm64",
    node: inputs.node.version,
    builder: inputs.builder,
    testedImage: inputs.testedImage,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    updaterProtocol: 1,
  };
}

export interface BuildIdentity {
  commit: string;
  channel: string;
  branch: string;
  epoch: string;
}

export interface ReleaseMetadata {
  format: 1;
  release: string;
  commit: string;
  branch: string;
  channel: string;
  sourceDateEpoch: number;
  platform: "linux-arm64";
  node: string;
  builder: BundleInputs["builder"];
  testedImage: BundleInputs["testedImage"];
  settingsSchemaVersion: number;
  updaterProtocol: 1;
}

export function renderReleaseManifest(metadata: ReleaseMetadata, sha256: string, bytes: number): string {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("Invalid bundle checksum or size");
  }
  const fields = {
    format: "1",
    release: metadata.release,
    commit: metadata.commit,
    channel: metadata.channel,
    platform: metadata.platform,
    node: metadata.node,
    archive: "bundle.tar.zst",
    sha256,
    bytes: String(bytes),
  };
  for (const value of Object.values(fields)) {
    if (!/^[a-zA-Z0-9.-]+$/.test(value)) {
      throw new Error("Release manifest contains an unsafe value");
    }
  }
  return Object.entries(fields)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
}
