import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkServiceBootstrap } from "./install-check/service-bootstrap-check.ts";
import { checkGuestVerification } from "./install-check/verification-check.ts";
import { checkBootstrapInterruption } from "./install-check/interruption-check.ts";
import { checkExistingBootstrap } from "./install-check/existing-bootstrap-check.ts";
import { REPOSITORY } from "./update-check/fixture.ts";

await mkdir(join(REPOSITORY, ".preview-shots"), { recursive: true });
const directory = await mkdtemp(join(REPOSITORY, ".preview-shots/installer-bootstrap-"));
try {
  const scope = process.argv[2];
  if (scope && !["service", "verification", "interruption", "existing"].includes(scope)) {
    throw new Error("Unknown installer bootstrap check scope");
  }
  if (!scope || scope === "service") {
    await checkServiceBootstrap(join(directory, "service"), process.argv[3]);
  }
  if (!scope || scope === "verification") {
    await checkGuestVerification(join(directory, "verification"));
  }
  if (!scope || scope === "interruption") {
    await checkBootstrapInterruption(directory);
  }
  if (!scope || scope === "existing") {
    await checkExistingBootstrap(join(directory, "existing"), process.argv[3]);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
