import assert from "assert/strict";
import childProcess from "child_process";
import { syncBuiltinESMExports } from "module";

export function installNetworkSecretSpies(secrets: readonly string[]): void {
  for (const name of ["spawn", "execFile"] as const) {
    const original = childProcess[name];
    childProcess[name] = ((...parameters: unknown[]) => {
      assertNoSecret(parameters, secrets);
      return Reflect.apply(original, childProcess, parameters);
    }) as typeof childProcess.spawn & typeof childProcess.execFile;
  }
  syncBuiltinESMExports();
  for (const name of ["log", "warn", "error"] as const) {
    const original = console[name];
    console[name] = (...parameters: unknown[]) => {
      assertNoSecret(parameters, secrets);
      Reflect.apply(original, console, parameters);
    };
  }
}

function assertNoSecret(value: unknown, secrets: readonly string[], seen = new Set<unknown>()): void {
  if (typeof value === "string") {
    assert.ok(
      secrets.every(secret => !value.includes(secret)),
      "A Wi-Fi password reached logs or child-process argv"
    );
  } else if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    if (value instanceof Error) {
      assertNoSecret(value.message, secrets, seen);
      assertNoSecret(value.cause, secrets, seen);
    }
    for (const nested of Object.values(value)) {
      assertNoSecret(nested, secrets, seen);
    }
  }
}
