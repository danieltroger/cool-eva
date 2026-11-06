import assert from "node:assert/strict";
import { checkInstalledApp, requestHealth, type HealthProbe } from "../../src/install/health.ts";
import { reportHealth } from "../../src/install/health-diagnostics.ts";

export async function checkStartupHealth(): Promise<void> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  try {
    const stable = healthFixture(milliseconds => (milliseconds < 20_000 ? "first" : "second"));
    const view = await checkInstalledApp("synthetic-release", stable.probe);
    assert.equal(view.processGeneration, "second");
    assert.equal(stable.elapsed(), 80_000, "A process restart must begin another full healthy minute");
    assert.equal(lines.length, 2, "Successful polling logs only reset and completion");
    assert.match(lines[0], /"event":"reset"/);
    assert.match(lines[1], /"event":"complete"/);
    const flapping = healthFixture(milliseconds => String(Math.floor(milliseconds / 40_000)));
    await assert.rejects(checkInstalledApp("synthetic-release", flapping.probe), /did not pass/);
    assert.equal(flapping.elapsed(), 180_000);
    const falseHealth = healthFixture(() => "same", false);
    await assert.rejects(checkInstalledApp("synthetic-release", falseHealth.probe), /did not pass/);
    assert.equal(falseHealth.elapsed(), 180_000);
    await checkHealthFailures(lines);
    await checkRequestDeadline();
  } finally {
    console.log = original;
  }
  console.log(
    "installer health: unchanged windows; request/body phase timings, safe causes, resets and quiet successful polling passed"
  );
}

async function checkHealthFailures(lines: string[]): Promise<void> {
  for (const phase of ["release-health request", "release-health body", "settings request", "settings body"] as const) {
    lines.length = 0;
    const fixture = healthFixture(() => "same");
    const request = fixture.probe.request;
    let failed = false;
    fixture.probe.request = async url => {
      fixture.advance(17);
      const matching = url.endsWith(phase.startsWith("settings") ? "/settings" : "/release-health");
      if (!failed && matching && phase.endsWith("request")) {
        failed = true;
        throw new TypeError("SYNTHETIC_TRANSPORT_SECRET", {
          cause: Object.assign(new Error("SYNTHETIC_CAUSE_SECRET"), { code: "ECONNREFUSED" }),
        });
      }
      const response = await request(url);
      if (!failed && matching && phase.endsWith("body")) {
        failed = true;
        response.json = async () => {
          fixture.advance(13);
          return JSON.parse('{"secret": SYNTHETIC_HEALTH_SECRET}');
        };
      }
      return response;
    };
    await checkInstalledApp("synthetic-release", fixture.probe);
    const failure = parseDiagnostic(lines[0]);
    assert.equal(failure.event, "failure");
    assert.equal(failure.phase, phase);
    assert.equal(failure.elapsedMs, phase.endsWith("request") ? 17 : 30);
    assert(Number(failure.totalMs) >= Number(failure.elapsedMs));
    assert.equal(failure.status, phase.endsWith("body") ? 200 : null);
    assert.equal(failure.name, phase.endsWith("request") ? "TypeError" : "SyntaxError");
    assert.equal(failure.cause, phase.endsWith("request") ? "ECONNREFUSED" : "unavailable");
    assert(!lines.join("\n").includes("SYNTHETIC"), "Health errors must not reveal source excerpts or messages");
    assert.equal(lines.length, 2, "One failure and one completion, not per-success logging");
  }
  for (const name of ["TimeoutError", "AbortError", "SYNTHETIC_NAME_SECRET"]) {
    const error = new Error("SYNTHETIC_MESSAGE_SECRET", { cause: { code: "not a safe SYNTHETIC code" } });
    error.name = name;
    reportHealth({ event: "failure", phase: "settings body", elapsedMs: 7, totalMs: 14, status: 503, error });
    const diagnostic = parseDiagnostic(lines.at(-1)!);
    assert.equal(diagnostic.name, name.startsWith("SYNTHETIC") ? "unavailable" : name);
    assert.equal(diagnostic.cause, "unavailable");
    assert(!lines.at(-1)!.includes("SYNTHETIC"));
  }
  for (const rejected of ["request", "reply"]) {
    lines.length = 0;
    const fixture = healthFixture(() => "same");
    const request = fixture.probe.request;
    let failed = false;
    fixture.probe.request = async url => {
      if (!failed && fixture.elapsed() === 20_000) {
        failed = true;
        if (rejected === "request") {
          throw new DOMException("SYNTHETIC_TIMEOUT_SECRET", "TimeoutError");
        }
        return new Response('{"ok":false}', { status: 503 });
      }
      return request(url);
    };
    await checkInstalledApp("synthetic-release", fixture.probe);
    assert.equal(fixture.elapsed(), 82_000, "A failed request/reply resets the complete healthy minute");
    assert.equal(parseDiagnostic(lines[0]).event, "reset");
    assert.equal(parseDiagnostic(lines[1]).event, "failure");
    assert.equal(parseDiagnostic(lines[1]).status, rejected === "reply" ? 503 : null);
    assert.equal(parseDiagnostic(lines[2]).event, "complete");
    assert.equal(lines.length, 3);
    assert(!lines.join("\n").includes("SYNTHETIC"));
  }
}

async function checkRequestDeadline(): Promise<void> {
  const fetch = globalThis.fetch;
  const timeout = AbortSignal.timeout;
  const controller = new AbortController();
  try {
    AbortSignal.timeout = milliseconds => {
      assert.equal(milliseconds, 3_000, "Per-request deadline must not grow");
      return controller.signal;
    };
    globalThis.fetch = async (_input, options) => {
      assert.equal(options?.signal, controller.signal);
      return new Response("{}");
    };
    await requestHealth("http://127.0.0.1/release-health");
  } finally {
    globalThis.fetch = fetch;
    AbortSignal.timeout = timeout;
  }
}

function parseDiagnostic(line: string): Record<string, unknown> {
  assert(line.startsWith("Setup health: "), line);
  return JSON.parse(line.slice("Setup health: ".length)) as Record<string, unknown>;
}

function healthFixture(
  generation: (milliseconds: number) => string,
  healthy = true
): { probe: HealthProbe; elapsed: () => number; advance: (duration: number) => void } {
  let milliseconds = 0;
  return {
    elapsed: () => milliseconds,
    advance: duration => {
      milliseconds += duration;
    },
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
