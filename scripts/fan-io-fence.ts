import { registerHooks } from "node:module";

// The fence that keeps a check's src/fan/ out of the real world.
//
// scripts/check-fan-ordering.ts and scripts/check-fan-pwm-bringup.ts run the REAL
// openFanPwm() so its sysfs write ORDER is what is under test. That means src/fan/pwm.ts
// is holding a genuine `fs/promises` unless something takes it away — and with one, the
// check WRITES TO /sys/class/pwm and spawns `pinctrl`, which on the bike's Pi drives the
// actual IBT-2. scripts/run-checks.ts and docs/diagnostics-and-checks.md §11.1 make "no
// bike" a claim about the suite; this is what keeps it a property of the code rather than
// of whichever machine happens to run it.
//
// ⚠️ AN ALLOW-LIST WHOSE DENY ARM THROWS, not a redirect list. A specifier that stops
// matching — `node:fs/promises` instead of `fs/promises`, a new import, a renamed file —
// must fail loudly at resolve time, not fall through to the real thing.

/** Bare specifiers src/fan/ may reach that touch nothing outside the process. */
const ALLOWED_BARE = new Set(["util"]);

/** What src/fan/ reaches the world with, and what therefore has to be stood in for. */
const REDIRECTED = new Set(["fs/promises", "child_process"]);

const served = new Set<string>();

interface ResolveContext {
  parentURL?: string;
}

interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
}

type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult;

let redirectTo: string | null = null;

/**
 * Points src/fan/'s `fs/promises` and `child_process` at `moduleUrl`.
 *
 * ⚠️ Call this BEFORE the first `import()` of anything under src/fan/, which is why those
 * imports are dynamic in both checks: a static one is resolved before any statement runs.
 *
 * ⚠️ Three limits, none of them live today, all worth knowing before relying on this as a
 * safety property. The fence is the PARENT's path, so a module outside src/fan/ that
 * control.ts transitively imports resolves normally (today that is ../can/signals.ts and
 * ../storage/encrypted-log.ts, whose appendReading() returns early when the log was never
 * opened — a property of that file, not of this one). `process.getBuiltinModule()` bypasses
 * resolution altogether. And the deny arm below is only fatal because both checks import
 * src/fan/ at top level with no try — a dynamic import inside a catch could swallow it.
 */
export function installFanIoFence(moduleUrl: string): void {
  redirectTo = moduleUrl;
  registerHooks({ resolve: resolveFanImport });
}

/** Which redirected specifiers the fence actually served. Never reset. */
export function redirectsServed(): string[] {
  return [...served];
}

function resolveFanImport(specifier: string, context: ResolveContext, nextResolve: NextResolve): ResolveResult {
  if (redirectTo === null || !(context.parentURL ?? "").includes("/src/fan/")) {
    return nextResolve(specifier, context);
  }
  if (REDIRECTED.has(specifier)) {
    served.add(specifier);
    return { url: redirectTo, shortCircuit: true };
  }
  if (specifier.startsWith(".") || ALLOWED_BARE.has(specifier)) {
    return nextResolve(specifier, context);
  }
  throw new Error(
    `${context.parentURL} imports \`${specifier}\`, which this check does not simulate. Nothing under src/fan/ ` +
      `may reach the real world while it runs — a real write here drives the IBT-2 on the bike's Pi. Fix it by ` +
      `adding \`${specifier}\` to REDIRECTED in scripts/fan-io-fence.ts and standing it in, or to ALLOWED_BARE ` +
      `if it touches nothing outside the process.`
  );
}
