import assert from "node:assert/strict";
import { checkInstalledApp, type HealthProbe } from "../../src/install/health.ts";

export async function checkStartupHealth(): Promise<void> {
  const stable = healthFixture(milliseconds => (milliseconds < 20_000 ? "first" : "second"));
  const view = await checkInstalledApp("synthetic-release", stable.probe);
  assert.equal(view.processGeneration, "second");
  assert.equal(stable.elapsed(), 80_000, "A process restart must begin another full healthy minute");
  const flapping = healthFixture(milliseconds => String(Math.floor(milliseconds / 40_000)));
  await assert.rejects(checkInstalledApp("synthetic-release", flapping.probe), /did not pass/);
  const falseHealth = healthFixture(() => "same", false);
  await assert.rejects(checkInstalledApp("synthetic-release", falseHealth.probe), /did not pass/);
}

function healthFixture(
  generation: (milliseconds: number) => string,
  healthy = true
): { probe: HealthProbe; elapsed: () => number } {
  let milliseconds = 0;
  return {
    elapsed: () => milliseconds,
    probe: {
      now: () => milliseconds,
      since: mark => milliseconds - mark,
      sleep: async duration => {
        milliseconds += duration;
      },
      request: async url =>
        new Response(
          JSON.stringify(
            url.endsWith("/release-health")
              ? { ok: healthy, release: "synthetic-release" }
              : { ok: true, fault: null, processGeneration: generation(milliseconds) }
          ),
          { status: 200 }
        ),
    },
  };
}
