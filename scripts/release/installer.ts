import type { ReleaseMetadata } from "./manifest.ts";

export function renderInstaller(template: string, metadata: ReleaseMetadata): string {
  const tag = `cool-eva-${metadata.release}`;
  if (
    !/^cool-eva-(main|branch-[a-z0-9.-]+)-[a-f0-9]{40}$/.test(tag) ||
    !/^https:\/\/downloads\.raspberrypi\.com\/[a-zA-Z0-9/._-]+\.img\.xz$/.test(metadata.testedImage.url)
  ) {
    throw new Error("Unsafe installer release identity");
  }
  const rendered = template
    .replace("@COOL_EVA_RELEASE_TAG@", tag)
    .replace("@COOL_EVA_TESTED_IMAGE@", metadata.testedImage.url);
  if (rendered === template || /@COOL_EVA_/.test(rendered)) {
    throw new Error("Installer template markers changed");
  }
  return rendered;
}

export function installerRemoteCommand(): string {
  return "sudo install -d -m 700 /var/cache/cool-eva-install && sudo curl -fsSL https://github.com/danieltroger/cool-eva/releases/latest/download/install.sh -o /var/cache/cool-eva-install/install.sh && sudo sh /var/cache/cool-eva-install/install.sh";
}

export function installerOneLine(): string {
  return `ssh -tt pi@cool-eva.local "${installerRemoteCommand()}"`;
}
