import ts from "typescript";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Whether the design preview still stands in for the bike the Pi describes.
//
// ⚠️ Written because of a specific failure. `VcuWriteStatus` gained `runningVersion` in #153 and
// the fixture never did; `public/views/vcu-write.js` destructures it, so the binding threw, the
// sheet froze on its "waiting for an answer" ellipsis, and the safety-gate line and
// `⚙️ Running <commit>` were absent from every screenshot taken for twelve days. The annotated
// sheet threw the same error once per panel while its own guard reported `data-preview-failed=0`.
// Nothing could see it: the fixture is data, `check-service-preview.ts` parses the generated page
// without running it, and a browser is deliberately not in this suite (§11.6).
//
// So this compares the fixtures against the interfaces the Pi serves, and the endpoints the
// preview answers against the ones `public/` fetches. It reads; it never runs the page. Parsing
// is TypeScript's own — already a devDependency, already what `npm run typecheck` runs — rather
// than the bracket-counting the two existing slicers use, because #170 records that both of those
// share one blind spot: neither skips string literals or comments.
//
// ⚠️ What it does NOT see is printed on every run, not only on failure. A fixture field nobody was
// looking at is the whole failure above, so the holes are named out loud rather than left implied.
//
// Run it against any template, which is how it is shown going red:
//   git show origin/main:scripts/app-preview-template.html > /tmp/main-template.html
//   node --experimental-strip-types scripts/check-preview-fixtures.ts /tmp/main-template.html

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * Which fixture constant stands in for which of the Pi's payloads.
 *
 * A template that mounts the whole app must declare all of them; one that mounts chosen panels is
 * held only to the ones it declares.
 */
const FIXTURES = [
  { constant: "WRITE_STATUS", type: "VcuWriteStatus" },
  { constant: "STATUS", type: "StatusPayload" },
  { constant: "READ_STATE", type: "VcuReadResponse" },
  { constant: "FAN", type: "FanReply" },
  { constant: "CHARGE_AUTO", type: "ChargeAutoResponse" },
];

/** Checked when no path is given on the command line. */
const TEMPLATES = ["scripts/app-preview-template.html", "scripts/service-preview-template.html"];

/** One type's members, or the arms of a union — kept apart, for the reason on unionArms(). */
type Shape = { kind: "members"; members: ts.PropertySignature[] } | { kind: "union"; arms: ts.TypeNode[] };

const failures: string[] = [];
/** Where the walk stopped, and why. Printed whether or not anything failed. */
const skipped: string[] = [];

console.log("\n──── scripts/check-preview-fixtures.ts ─────────────────────────────────────────");
console.log("     that the preview's fixtures still match the payloads the Pi serves");

const types = await indexDeclaredTypes();
const tablePaths = await pathsServedFromTables();
const fetched = await pathsFetchedByTheDashboard();
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
  // off the source rather than the filename — the same distinction check-service-preview.ts draws
  // by looking for this call — so a renamed or copied template is judged by what it does.
  const mountsTheApp = /__imp\("app\.js"\)|imp\("app\.js"\)/.test(harness);

  for (const fixture of FIXTURES) {
    const literal = findObjectLiteral(source, fixture.constant);
    if (!literal) {
      if (mountsTheApp) {
        failures.push(`${label}: no ${fixture.constant} fixture, so nothing stands in for the Pi's ${fixture.type}`);
      }
      continue;
    }
    const shape = namedShape(fixture.type);
    if (!shape) {
      failures.push(
        `${label}: ${fixture.constant} claims to be a ${fixture.type}, and src/ declares no such object type`
      );
      continue;
    }
    checkShape(literal, shape, `${label}: ${fixture.constant}`, new Set([fixture.type]));
  }

  if (mountsTheApp) {
    const answered = pathsAnsweredBy(source);
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
    const endpoints = mountsTheApp
      ? `${fetched.size} endpoints answered, `
      : "panels rather than the app, so endpoints are not its contract; ";
    console.log(`  ${label}: ${endpoints}fixtures match`);
  }
}

if (skipped.length > 0) {
  console.log(`  not descended into: ${skipped.join("; ")}`);
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log("\n✓ every fixture matches its payload type, and every endpoint the dashboard fetches has an answer");

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

/** The object literal `const <name> = { … }` is initialised with, anywhere in the file. */
function findObjectLiteral(node: ts.Node, name: string): ts.ObjectLiteralExpression | null {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === name &&
    node.initializer &&
    ts.isObjectLiteralExpression(node.initializer)
  ) {
    return node.initializer;
  }
  let found: ts.ObjectLiteralExpression | null = null;
  ts.forEachChild(node, child => {
    found = found ?? findObjectLiteral(child, name);
  });
  return found;
}

/**
 * Every interface and object-shaped type alias in `src/`, by name.
 *
 * A name declared twice is kept as both: a lookup that finds two cannot say which payload the
 * fixture is being held to, and taking the first is how a check comes to assert the wrong contract
 * quietly.
 */
async function indexDeclaredTypes(): Promise<Map<string, ts.Node[]>> {
  const index = new Map<string, ts.Node[]>();
  for (const entry of await readdir(join(ROOT, "src"), { recursive: true })) {
    if (!entry.endsWith(".ts")) {
      continue;
    }
    const source = ts.createSourceFile(
      entry,
      await readFile(join(ROOT, "src", entry), "utf8"),
      ts.ScriptTarget.ESNext,
      true
    );
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        index.set(statement.name.text, [...(index.get(statement.name.text) ?? []), statement]);
      }
    }
  }
  return index;
}

/** The shape a type name resolves to, or null when src/ has no single object-shaped declaration of it. */
function namedShape(name: string): Shape | null {
  const declarations = types.get(name);
  if (!declarations || declarations.length !== 1) {
    return null;
  }
  const declaration = declarations[0];
  if (ts.isInterfaceDeclaration(declaration)) {
    return { kind: "members", members: declaration.members.filter(ts.isPropertySignature) };
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    return shapeOfTypeNode(declaration.type);
  }
  return null;
}

function shapeOfTypeNode(node: ts.TypeNode): Shape | null {
  if (ts.isTypeLiteralNode(node)) {
    return { kind: "members", members: node.members.filter(ts.isPropertySignature) };
  }
  if (ts.isUnionTypeNode(node)) {
    return { kind: "union", arms: [...node.types] };
  }
  if (ts.isTypeReferenceNode(node) && !node.typeArguments) {
    return namedShape(node.typeName.getText());
  }
  return null;
}

/** Checks one object literal against a shape, then walks into whatever it can. */
function checkShape(literal: ts.ObjectLiteralExpression, shape: Shape, at: string, seen: Set<string>): void {
  if (shape.kind === "union") {
    checkAgainstUnion(literal, shape.arms, at, seen);
    return;
  }
  const comparison = compare(literal, shape.members, at);
  failures.push(...comparison.messages);
  descendInto(comparison.matched, at, seen);
}

/**
 * A fixture against a union: it has to satisfy exactly ONE arm.
 *
 * ⚠️ Not the merged members of all of them. Both templates' `clock` fixture is a `trustworthy:
 * true` PiClockVerdict carrying the OTHER arm's `reasons` array — a value the type does not permit
 * and a merged check would wave through. When nothing fits, the nearest arm is what gets reported;
 * printing every arm's diff buries the one line that matters.
 */
function checkAgainstUnion(
  literal: ts.ObjectLiteralExpression,
  arms: ts.TypeNode[],
  at: string,
  seen: Set<string>
): void {
  let nearest: Comparison | null = null;
  for (const arm of arms) {
    const shape = shapeOfTypeNode(arm);
    if (!shape || shape.kind !== "members") {
      continue;
    }
    const comparison = compare(literal, shape.members, at);
    if (comparison.messages.length === 0) {
      descendInto(comparison.matched, at, seen);
      return;
    }
    if (nearest === null || comparison.messages.length < nearest.messages.length) {
      nearest = comparison;
    }
  }
  if (nearest === null) {
    skipped.push(`${at} (a union with no object-shaped arm)`);
    return;
  }
  failures.push(...nearest.messages.map(message => `${message} — measured against the nearest shape the type allows`));
}

interface Matched {
  member: ts.PropertySignature;
  value: ts.Expression;
}

interface Comparison {
  messages: string[];
  matched: Matched[];
}

/** What a literal is missing, what it invents, and which members it did supply. */
function compare(literal: ts.ObjectLiteralExpression, members: ts.PropertySignature[], at: string): Comparison {
  const messages: string[] = [];
  const matched: Matched[] = [];
  const present = new Map<string, ts.Expression>();
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) {
      present.set(propertyName(property.name), property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      present.set(property.name.text, property.name);
    } else {
      // A spread hides the keys it contributes, and a check that shrugged at one would call a
      // fixture complete whatever the spread held.
      messages.push(`${at} uses a spread this check cannot read — write the fixture's keys out`);
    }
  }

  for (const member of members) {
    const name = propertyName(member.name);
    const value = present.get(name);
    if (value === undefined) {
      if (member.questionToken === undefined) {
        messages.push(`${at}.${name} is missing — the Pi always sends it, so a view that reads it gets undefined`);
      }
      continue;
    }
    matched.push({ member, value });
  }

  const declared = new Set(members.map(member => propertyName(member.name)));
  for (const name of present.keys()) {
    if (!declared.has(name)) {
      messages.push(
        `${at}.${name} is not a field the Pi sends — the fixture describes a bike this software does not serve`
      );
    }
  }
  return { messages, matched };
}

function descendInto(matched: Matched[], at: string, seen: Set<string>): void {
  for (const { member, value } of matched) {
    descend(member, value, `${at}.${propertyName(member.name)}`, seen);
  }
}

/**
 * Walks into one member when both the type and the fixture have a shape worth comparing.
 *
 * ⚠️ A member this cannot walk into is announced only when the TYPE names something structured —
 * an array of records, a `Record<>`, another interface. `enabled: boolean` was never descendable
 * and listing it as a hole would bury the two or three that are real under thirty that are not.
 */
function descend(member: ts.PropertySignature, value: ts.Expression, at: string, seen: Set<string>): void {
  const type = member.type;
  if (!type) {
    return;
  }
  if (value.kind === ts.SyntaxKind.NullKeyword) {
    if (!admitsNull(type)) {
      failures.push(`${at} is null, and the Pi's type has no null in it`);
    }
    return;
  }
  const name = ts.isTypeReferenceNode(type) ? type.typeName.getText() : null;
  if (name !== null && seen.has(name)) {
    skipped.push(`${at} (${name} again — a type that contains itself)`);
    return;
  }
  const shape = ts.isTypeReferenceNode(type) && type.typeArguments ? null : shapeOfTypeNode(type);
  if (shape && ts.isObjectLiteralExpression(value)) {
    checkShape(value, shape, at, name === null ? seen : new Set([...seen, name]));
    return;
  }
  if (couldHoldAnObject(type, 0)) {
    skipped.push(`${at} (${describeHole(type, value)})`);
  }
}

/**
 * Whether a member could have carried an object worth walking into.
 *
 * ⚠️ The gate on what gets announced as a hole. Without it every string-literal union — every
 * `phase`, every `mode` — was listed as unwalked, and twenty lines of things that were never
 * walkable is how the two or three real holes stop being read.
 */
function couldHoldAnObject(type: ts.TypeNode, depth: number): boolean {
  if (depth > 4) {
    return false;
  }
  if (ts.isTypeLiteralNode(type)) {
    return true;
  }
  if (ts.isArrayTypeNode(type)) {
    return couldHoldAnObject(type.elementType, depth + 1);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.some(arm => couldHoldAnObject(arm, depth + 1));
  }
  if (!ts.isTypeReferenceNode(type)) {
    return false;
  }
  if (type.typeArguments) {
    // A generic this cannot open. Named because what is inside it is genuinely unknown here.
    return true;
  }
  const shape = namedShape(type.typeName.getText());
  if (!shape) {
    return false;
  }
  return shape.kind === "members" || shape.arms.some(arm => couldHoldAnObject(arm, depth + 1));
}

/** Why a structured member went unchecked, in the words that say what to do about it. */
function describeHole(type: ts.TypeNode, value: ts.Expression): string {
  if (ts.isTypeReferenceNode(type) && type.typeArguments) {
    return `${type.typeName.getText()}<…> — this check does not open generics`;
  }
  if (ts.isArrayTypeNode(type)) {
    return "an array — this check compares objects, not their elements";
  }
  if (!ts.isObjectLiteralExpression(value)) {
    return "the fixture reaches it through a name rather than writing it out here";
  }
  return "src/ declares no single object-shaped type for it";
}

/**
 * ⚠️ `null` in a type position is a LiteralTypeNode wrapping the keyword, never the bare keyword.
 * Testing for the keyword itself reported `string | null` as admitting no null and turned every
 * correctly-null field in the fixture red.
 */
function admitsNull(type: ts.TypeNode): boolean {
  if (ts.isLiteralTypeNode(type)) {
    return type.literal.kind === ts.SyntaxKind.NullKeyword;
  }
  if (type.kind === ts.SyntaxKind.NullKeyword || type.kind === ts.SyntaxKind.UndefinedKeyword) {
    return true;
  }
  return ts.isUnionTypeNode(type) && type.types.some(admitsNull);
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

/**
 * Every path the dashboard fetches, and one file that fetches it.
 *
 * A `fetch()` whose argument this cannot read fails rather than being passed over: the endpoint it
 * names would be exactly the one nobody had stubbed.
 */
async function pathsFetchedByTheDashboard(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(join(ROOT, "public"), { recursive: true })) {
    if (!entry.endsWith(".js") || entry.startsWith("vendor")) {
      continue;
    }
    const text = await readFile(join(ROOT, "public", entry), "utf8");
    collectFetches(ts.createSourceFile(entry, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS), entry, found);
  }
  return found;
}

function collectFetches(node: ts.Node, file: string, found: Map<string, string>): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
    const argument = node.arguments[0];
    const path = argument ? literalPath(argument) : null;
    if (path === null) {
      failures.push(`${file}: a fetch() whose path this check cannot read — ${node.getText().slice(0, 60)}`);
    } else {
      found.set(path, file);
    }
  }
  ts.forEachChild(node, child => collectFetches(child, file, found));
}

/** The path a fetch argument names, up to its query string, or null when it is computed. */
function literalPath(argument: ts.Expression): string | null {
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text.split("?")[0];
  }
  if (ts.isTemplateExpression(argument)) {
    return argument.head.text.split("?")[0];
  }
  return null;
}

/** Every path a template answers: the `path === "…"` branches of its stubbed fetch, plus the tables. */
function pathsAnsweredBy(source: ts.SourceFile): Set<string> {
  const answered = new Set<string>(tablePaths);
  collectComparedPaths(source, answered);
  return answered;
}

function collectComparedPaths(node: ts.Node, into: Set<string>): void {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isStringLiteral(node.right) &&
    node.right.text.startsWith("/")
  ) {
    into.add(node.right.text);
  }
  ts.forEachChild(node, child => collectComparedPaths(child, into));
}

/**
 * The table paths, read out of the builder rather than restated here.
 *
 * They are keys in `build-service-preview.ts` and not literals in the template, so a template that
 * answered none of them by hand is still answering them.
 */
async function pathsServedFromTables(): Promise<Set<string>> {
  const text = await readFile(join(ROOT, "scripts", "build-service-preview.ts"), "utf8");
  const source = ts.createSourceFile("build-service-preview.ts", text, ts.ScriptTarget.ESNext, true);
  const literal = findTablesObject(source);
  if (!literal) {
    failures.push(
      "build-service-preview.ts declares no `tables` object, so this check cannot tell which paths it serves"
    );
    return new Set<string>();
  }
  return new Set(
    literal.properties.flatMap(property => (ts.isPropertyAssignment(property) ? [propertyName(property.name)] : []))
  );
}

/** `const tables = JSON.stringify({ … })` — the object inside the call. */
function findTablesObject(node: ts.Node): ts.ObjectLiteralExpression | null {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "tables" && node.initializer) {
    const initialiser = node.initializer;
    if (ts.isObjectLiteralExpression(initialiser)) {
      return initialiser;
    }
    const [first] = ts.isCallExpression(initialiser) ? initialiser.arguments : [];
    if (first && ts.isObjectLiteralExpression(first)) {
      return first;
    }
  }
  let found: ts.ObjectLiteralExpression | null = null;
  ts.forEachChild(node, child => {
    found = found ?? findTablesObject(child);
  });
  return found;
}
