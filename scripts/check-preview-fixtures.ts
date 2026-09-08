import ts from "typescript";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serverFacts } from "./preview-server-facts.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { pathsAnsweredBy, pathsFetchedByTheDashboard, pathsServedFromTables } from "./preview-endpoints.ts";

// Whether the design preview's fixtures still describe the bike the Pi describes.
//
// ⚠️ It does NOT compare the shapes itself. It lifts each fixture literal out of the template,
// writes it into a throwaway `.ts` annotated with the type its endpoint serves, and hands that to
// `tsc`. A hand-rolled comparison was written first and rejected in review: at 524 lines it still
// missed a boolean swapped for a string, an array element with a renamed field, and a union arm
// satisfied on the wrong discriminant — two of which produce a throwing binding and a panel that
// looks like it is still loading. TypeScript gets all three right for nothing.
//
// What this exists to stop, and what it found on its first run:
// docs/diagnostics-and-checks.md §11.7. Endpoint coverage is ./preview-endpoints.ts.
//
// Run it against any template, which is how it is shown going red:
//   git show origin/main:scripts/app-preview-template.html > /tmp/main-template.html
//   node --experimental-strip-types scripts/check-preview-fixtures.ts /tmp/main-template.html

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * Which fixture constant stands in for which of the Pi's payloads, and where that type lives.
 *
 * ⚠️ Five of the eleven replies the preview writes. The other six are built inline inside the
 * stubbed `fetch`, mostly out of the request, so a table keyed on a constant's name cannot reach
 * them — and `/vcu-probe` was missing a required field for exactly that reason. Keying this by
 * PATH instead, off the same walk preview-endpoints.ts already does, is what closes it.
 * docs/diagnostics-and-checks.md §11.7 says so where a reader of the ✓ will see it.
 */
const FIXTURES = [
  { constant: "WRITE_STATUS", type: "VcuWriteStatus", from: "src/vcu/write-runner.ts" },
  { constant: "STATUS", type: "StatusPayload", from: "src/http/status.ts" },
  { constant: "READ_STATE", type: "VcuReadResponse", from: "src/http/vcu-read.ts" },
  { constant: "FAN", type: "FanReply", from: "src/http/fan.ts" },
  { constant: "CHARGE_AUTO", type: "ChargeAutoResponse", from: "src/http/charge-auto.ts" },
  { constant: "LIFETIME_READ", type: "LifetimeReadResponse", from: "src/http/lifetime-read.ts" },
];

/**
 * The per-scene overlays, applied with Object.assign and so part of no fixture literal — including
 * the DC scene's `chargeAck`, which is the field this check exists to protect. Checked as partials:
 * an overlay may leave a field alone, but it may not invent or mistype one.
 */
const OVERLAYS: { key: string; as: string; from: string | null; name: string | null }[] = [
  { key: "gate", as: "Partial<ServiceGateVerdict>", from: "src/vcu/service-gate.ts", name: "ServiceGateVerdict" },
  { key: "fan", as: "Partial<FanReply>", from: "src/http/fan.ts", name: "FanReply" },
  { key: "fanAuto", as: "Partial<FanAutoReply>", from: "src/http/fan.ts", name: "FanAutoReply" },
  { key: "chargeAck", as: "ChargeAckState", from: "src/charge/ack-watch.ts", name: "ChargeAckState" },
  { key: "funGate", as: "FunGate", from: "src/fan/fun.ts", name: "FunGate" },
  { key: "chargeAutoReason", as: "ChargeAutoReason", from: "src/charge/auto-curve.ts", name: "ChargeAutoReason" },
  { key: "commandedAmps", as: "number | null", from: null, name: null },
];

/** Scene keys that are not a payload, so carry nothing for a type to check. */
const NOT_A_PAYLOAD = new Set(["signals"]);

/** `[value, unit, group]`, and optionally the moment it was recorded. */
const READING = "[value: number, unit: string, group: string, ts?: number]";

/** Checked when no path is given on the command line. */
const TEMPLATES = ["scripts/app-preview-template.html", "scripts/service-preview-template.html"];

const failures: string[] = [];

console.log("\n──── scripts/check-preview-fixtures.ts ─────────────────────────────────────────");
console.log("     that the preview's NAMED fixtures still match the payloads the Pi serves");

const fetched = await pathsFetchedByTheDashboard(failures);
const tablePaths = await pathsServedFromTables(failures);
const argumentPaths = process.argv.slice(2).filter(argument => !argument.startsWith("--"));
const templates = argumentPaths.length > 0 ? argumentPaths : TEMPLATES.map(path => join(ROOT, path));

for (const templatePath of templates) {
  // A path from outside the repo — how the red run against origin/main's template is done — keeps
  // its own name rather than becoming a stack of `../`.
  const inRepo = relative(ROOT, templatePath);
  const label = inRepo && !inRepo.startsWith("..") ? inRepo : templatePath;
  const harness = harnessSource(await readFile(templatePath, "utf8"));
  if (harness === null) {
    failures.push(`${label}: expected exactly one <script> block to read the fixtures out of`);
    continue;
  }
  const source = ts.createSourceFile(label, harness, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const failuresBefore = failures.length;
  // ⚠️ The app template mounts the whole dashboard, so every endpoint public/ fetches is reachable
  // in it; the annotated sheet mounts a chosen set of panels, which is a different contract. Read
  // off the source rather than the filename — the distinction check-service-preview.ts already
  // draws — so a renamed or copied template is judged by what it does.
  const mountsTheApp = /__imp\("app\.js"\)|imp\("app\.js"\)/.test(harness);

  await checkFixtureTypes(source, label, mountsTheApp);
  checkReadings(source, label);
  if (mountsTheApp) {
    const answered = pathsAnsweredBy(source, tablePaths);
    for (const [path, asker] of fetched) {
      if (!answered.has(path)) {
        failures.push(
          `${label}: nothing answers ${path}, which ${asker} fetches — the preview rejects it, and the ` +
            "view that asked renders as if the bike had no answer"
        );
      }
    }
  }
  if (failures.length === failuresBefore) {
    const endpoints = mountsTheApp ? `${fetched.size} endpoints answered, ` : "panels rather than the app; ";
    console.log(`  ${label}: ${endpoints}fixtures type-check against the Pi's own payloads`);
  }
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log("\n✓ every named fixture matches its payload type, and every endpoint the dashboard fetches has an answer");

/**
 * Every reading a scene broadcasts, against the unit and group the Pi files it under.
 *
 * ⚠️ Not covered by the types above: a reading is a tuple of `[number, string, string]`, so
 * `["km", "battery"]` type-checks perfectly against a key the registry files under `energy` — and
 * `group` is what public/lib/store.js sorts the All tab by, so a wrong one puts a signal in a
 * section the bike never puts it in. `range_km` was in the wrong group here, and this diff had
 * copied it into two more scenes before this assertion existed.
 */
function checkReadings(source: ts.SourceFile, label: string): void {
  const known = new Map(SIGNALS.map(signal => [signal.key, signal]));
  for (const [key, unit, group] of readingTriples(source)) {
    const definition = known.get(key);
    if (!definition) {
      failures.push(`${label}: the scenes broadcast ${key}, which src/can/registry.ts does not define`);
    } else if (definition.unit !== unit || definition.group !== group) {
      failures.push(
        `${label}: ${key} is broadcast as [${unit}, ${group}] and the Pi files it under ` +
          `[${definition.unit}, ${definition.group}]`
      );
    }
  }
}

/**
 * `key: [value, unit, group]` entries, from the SIGNAL TABLES only.
 *
 * ⚠️ Not from the whole harness: a write target's `warnings` is also an array of strings, and a
 * walk that took every array-valued property reported the bike broadcasting a signal called
 * `warnings`.
 */
function readingTriples(source: ts.SourceFile): [string, string, string][] {
  const found: [string, string, string][] = [];
  const declarations = topLevelDeclarations(source);
  const base = declarations.get("PARKED_SIGNALS");
  if (base) {
    collectTriples(base, found);
  }
  for (const scene of namedEntries(declarations.get("SCENES") ?? undefined)) {
    for (const entry of namedEntries(scene.value)) {
      if (entry.name === "signals") {
        collectTriples(entry.value, found);
      }
    }
  }
  return found;
}

function collectTriples(node: ts.Node, into: [string, string, string][]): void {
  if (ts.isPropertyAssignment(node) && ts.isArrayLiteralExpression(node.initializer)) {
    const [, unit, group] = node.initializer.elements;
    if (unit && group && ts.isStringLiteral(unit) && ts.isStringLiteral(group)) {
      into.push([propertyName(node.name), unit.text, group.text]);
    }
  }
  ts.forEachChild(node, child => collectTriples(child, into));
}

/** The text of a property's name, whether it is quoted or bare. */
function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

/**
 * The harness `<script>` — the one the fixtures live in.
 *
 * Both templates carry exactly one and the builder substitutes into it, so a template that grew a
 * second would need this to say which. It refuses rather than guessing.
 */
function harnessSource(html: string): string | null {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  return blocks.length === 1 ? blocks[0] : null;
}

/**
 * Writes the fixtures into a throwaway module, annotated with the types the Pi serves, and lets
 * `tsc` say whether they fit.
 *
 * ⚠️ `--ignoreConfig` plus an explicit `src/types.d.ts`: without the shim every module that reaches
 * write-runner.ts fails on `socketcan`, a Linux-only optional dependency absent on macOS and on CI.
 * That is an error about the REPO rather than about the fixture, and reporting it here would be
 * noise on every machine this check is meant to run on.
 */
async function checkFixtureTypes(source: ts.SourceFile, label: string, mountsTheApp: boolean): Promise<void> {
  const declarations = topLevelDeclarations(source);
  const present = FIXTURES.filter(fixture => declarations.has(fixture.constant));
  if (mountsTheApp) {
    for (const fixture of FIXTURES) {
      if (!declarations.has(fixture.constant)) {
        // The annotated sheet declares only the fixtures its panels need, and is held to those.
        failures.push(`${label}: no ${fixture.constant} fixture, so nothing stands in for the Pi's ${fixture.type}`);
      }
    }
  }
  if (present.length === 0) {
    return;
  }

  const imports = new Map<string, Set<string>>();
  for (const fixture of present) {
    addImport(imports, fixture.from, fixture.type);
  }
  // SERVER is a placeholder the builder substitutes, so the fixtures are checked against the REAL
  // object it will inject — which is also what makes `SERVER.fanReason.DC_SESSION` a typo the
  // fixture cannot get away with.
  const lines = [`const SERVER = ${JSON.stringify(serverFacts())} as const;`];
  for (const fixture of present) {
    const literal = inlined(declarations.get(fixture.constant)!, source, declarations);
    // ⚠️ TWICE, and the second is not redundant. TypeScript's excess-property check only fires on a
    // FRESH literal and reports the first mismatch it finds — so against main's template the
    // invented `gate.readings` masked the missing `runningVersion` entirely, hiding the very field
    // this check was written for. The second assignment goes through a widened copy, which is not
    // fresh, so it sees what is ABSENT; mapping every value to `unknown` keeps it to presence
    // alone, since a widened copy has lost the literal types the first assignment checks.
    lines.push(`const ${fixture.constant}: ${fixture.type} = ${literal};`);
    lines.push(`const __wide_${fixture.constant} = ${literal};`);
    lines.push(
      `const __has_${fixture.constant}: { [K in keyof ${fixture.type}]: unknown } = __wide_${fixture.constant};`
    );
  }
  lines.push(...sceneAssertions(source, declarations, imports, label));

  const header = [...imports].map(
    ([from, names]) => `import type { ${[...names].join(", ")} } from ${JSON.stringify(join(ROOT, from))};`
  );
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-fixture-"));
  const file = join(directory, "fixtures.ts");
  await writeFile(file, `${header.join("\n")}\n\n${lines.join("\n")}\n`, "utf8");
  try {
    await run("npx", [
      "tsc",
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--target",
      "esnext",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--allowImportingTsExtensions",
      "--skipLibCheck",
      "--lib",
      "esnext,dom",
      join(ROOT, "src/types.d.ts"),
      file,
    ]);
  } catch (error) {
    for (const line of diagnostics(error, file)) {
      failures.push(`${label}: ${line}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The signal tables and the per-scene overlays, which no fixture literal contains.
 *
 * A signal is a tuple rather than a named payload, and a malformed one renders NaN rather than
 * failing — the quietest way this fixture can lie.
 */
function sceneAssertions(
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
  imports: Map<string, Set<string>>,
  label: string
): string[] {
  const lines: string[] = [];
  const base = declarations.get("PARKED_SIGNALS");
  if (base) {
    lines.push(`const __base: Record<string, ${READING}> = ${inlined(base, source, declarations)};`);
  }
  const scenes = declarations.get("SCENES");
  if (!scenes) {
    return lines;
  }
  for (const scene of namedEntries(scenes)) {
    for (const entry of namedEntries(scene.value)) {
      const overlay = OVERLAYS.find(candidate => candidate.key === entry.name);
      const as = entry.name === "signals" ? `Record<string, ${READING}>` : overlay?.as;
      if (as === undefined) {
        // ⚠️ Red, not skipped. This defaulted to `continue`, so a scene key nobody had listed —
        // `funGate`, `chargeAutoReason` and `commandedAmps` were all three of them — went
        // unchecked while the run said the fixtures type-check. An undefined `funGate` is
        // broadcast as a signal and an undefined `chargeAutoReason` empties the tile's sentence:
        // quietly wrong panels, which is the whole failure this file exists for.
        if (!NOT_A_PAYLOAD.has(entry.name)) {
          failures.push(
            `${label}: the ${scene.name} scene sets ${entry.name}, which no row in OVERLAYS gives a type — ` +
              "add one, or list it in NOT_A_PAYLOAD to say it carries nothing to check"
          );
        }
        continue;
      }
      if (overlay?.from && overlay.name) {
        addImport(imports, overlay.from, overlay.name);
      }
      const name = `__${entry.name}_${scene.name}`;
      lines.push(`const ${name}: ${as} = ${inlined(entry.value, source, declarations)};`);
    }
  }
  return lines;
}

/**
 * One literal with every reference to another top-level constant spliced in.
 *
 * ⚠️ Inlined rather than emitted as separate `const`s, and that is the whole of whether this works.
 * A bare `const TARGETS = [{ micro: "A9", … }]` widens `micro` to `string` before anything says it
 * should be `VcuMicro`, so every fixture reached through a name failed as a false positive. Under
 * one contextually-typed literal TypeScript keeps the literal types and checks the array elements,
 * the discriminated unions and the scalars for real.
 */
function inlined(node: ts.Expression, source: ts.SourceFile, declarations: Map<string, ts.Expression>): string {
  const text = node.getText(source);
  const start = node.getStart(source);
  const splices: { from: number; to: number; with: string }[] = [];
  collectReferences(node, declarations, splices, source);
  let out = text;
  for (const splice of splices.sort((left, right) => right.from - left.from)) {
    out = `${out.slice(0, splice.from - start)}(${splice.with})${out.slice(splice.to - start)}`;
  }
  return out;
}

function collectReferences(
  node: ts.Node,
  declarations: Map<string, ts.Expression>,
  into: { from: number; to: number; with: string }[],
  source: ts.SourceFile
): void {
  if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) {
    collectReferences(node.initializer, declarations, into, source);
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    collectReferences(node.expression, declarations, into, source);
    return;
  }
  if (ts.isIdentifier(node) && declarations.has(node.text) && node.text !== "SERVER") {
    const referenced = declarations.get(node.text)!;
    into.push({ from: node.getStart(source), to: node.getEnd(), with: inlined(referenced, source, declarations) });
    return;
  }
  ts.forEachChild(node, child => collectReferences(child, declarations, into, source));
}

/**
 * tsc's own words, with the throwaway file's path taken off the front.
 *
 * ⚠️ An error in a file that is NOT the generated one means the repo does not compile, which this
 * check must not report as a fixture problem — `npm run typecheck` owns that and says it better.
 */
function diagnostics(error: unknown, file: string): string[] {
  const output = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : String(error);
  const ours = output
    .split("\n")
    .filter(line => line.includes(file))
    .map(line => line.slice(line.indexOf(file) + file.length).replace(/^\(\d+,\d+\):\s*/, ""))
    // ⚠️ Rewritten, not passed through. tsc prints the whole fixture and then the whole payload
    // type before naming what is absent, which puts the two words that matter at the end of a
    // 599-character line — in a check whose output is read in a terminal.
    .map(line => {
      // Greedy on purpose: the payload type printed in between contains colons of its own.
      const missing = /is missing the following propert(?:y|ies) from .*: (.*)$/.exec(line);
      return missing
        ? `${line.slice(0, line.indexOf(":") + 1)} missing from the payload the Pi sends: ${missing[1]}`
        : line;
    });
  if (ours.length === 0) {
    return [`tsc could not check the fixtures — the repo itself does not compile:\n${output.trim()}`];
  }
  return ours;
}

/** Every `const <name> = …` at the top level of the harness, by name, in source order. */
function topLevelDeclarations(source: ts.SourceFile): Map<string, ts.Expression> {
  const found = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        found.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return found;
}

/** The `name: { … }` entries of an object literal. */
function namedEntries(node: ts.Expression | undefined): { name: string; value: ts.Expression }[] {
  if (!node || !ts.isObjectLiteralExpression(node)) {
    return [];
  }
  return node.properties.flatMap(property =>
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)
      ? [{ name: property.name.text, value: property.initializer }]
      : []
  );
}

function addImport(imports: Map<string, Set<string>>, from: string, name: string): void {
  imports.set(from, (imports.get(from) ?? new Set()).add(name));
}
