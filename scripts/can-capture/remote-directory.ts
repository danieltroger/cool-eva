import { settingsPaths } from "../../src/settings/paths.ts";
import { LEGACY_CAPTURE_DIRECTORY } from "./unit.ts";
import { CAPTURE_PRUNE_HELPER } from "../../src/storage/capture-pruner.ts";

export function captureDirectoryCommand(): string {
  return `if [ -d ${settingsPaths().captureDirectory} ]; then
  cd ${settingsPaths().captureDirectory}
else
  cd ${LEGACY_CAPTURE_DIRECTORY}
fi`;
}

export function deleteCaptureCommand(): string {
  return `set -eu
if [ -d ${settingsPaths().captureDirectory} ]; then
  sudo -n ${CAPTURE_PRUNE_HELPER}
  cd ${settingsPaths().captureDirectory}
else
  cd ${LEGACY_CAPTURE_DIRECTORY}
  while IFS= read -r name; do
    rm -f -- "$name"
    if [ -e "$name" ]; then printf 'STILL\\t%s\\n' "$name"; else printf 'GONE\\t%s\\n' "$name"; fi
  done
fi
df -Pk . | tail -1`;
}
