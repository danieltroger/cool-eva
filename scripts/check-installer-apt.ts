import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkPeriodicApt } from "./install-check/apt-check.ts";
import { checkStartupHealth } from "./install-check/health-check.ts";
import { checkBootstrap } from "./install-check/bootstrap-check.ts";
import { REPOSITORY } from "./update-check/fixture.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkPeriodicAptSystemd } from "./install-check/apt-systemd-check.ts";

await mkdir(join(REPOSITORY, ".preview-shots"), { recursive: true });
const directory = await mkdtemp(join(REPOSITORY, ".preview-shots/installer-apt-"));
try {
  switch (process.argv[2]) {
    case undefined:
      await checkPeriodicApt(directory);
      break;
    case "health":
      await checkStartupHealth();
      break;
    case "entry":
      await checkBootstrap(directory, REPOSITORY, "periodic-admitted");
      break;
    case "native":
      await checkPeriodicAptSystemd(
        directory,
        async (...arguments_) => {
          await promisify(execFile)("systemctl", arguments_, { timeout: 10_000 });
        },
        process.argv[3]
      );
      break;
    default:
      throw new Error("Unknown periodic APT fixture selection");
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
