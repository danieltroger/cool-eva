export function reportHealth(observation: HealthObservation): void {
  const error = observation.error;
  const name = error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : "unavailable";
  const cause = error instanceof Error ? error.cause : null;
  const code =
    cause !== null && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : "";
  console.log(
    "Setup health:",
    JSON.stringify({
      event: observation.event,
      phase: observation.phase,
      elapsedMs: Math.round(observation.elapsedMs),
      totalMs: Math.round(observation.totalMs),
      status: observation.status,
      name,
      cause: /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "unavailable",
    })
  );
}

export interface HealthObservation {
  event: "failure" | "reset" | "complete";
  phase: "release-health request" | "release-health body" | "settings request" | "settings body" | "healthy interval";
  elapsedMs: number;
  totalMs: number;
  status: number | null;
  error?: unknown;
}

const ERROR_NAMES = new Set(["TimeoutError", "TypeError", "SyntaxError", "AbortError"]);
