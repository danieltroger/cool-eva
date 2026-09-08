import ts from "typescript";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Which endpoints the dashboard asks for, and which ones a preview template answers.
//
// Its own module because it is a different question from whether the FIXTURES are right
// (./check-preview-fixtures.ts, which runs both): this one never looks at a payload's shape, only
// at whether anybody answers the door. The gap it exists for is three endpoints the app fetched and
// the preview rejected — /fan, /charge-auto and /can-restart — which made the sheet's fan section
// render nothing and #176's control never appear.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * Every path the dashboard fetches, and one file that fetches it.
 *
 * A `fetch()` whose argument cannot be read is reported rather than passed over: the endpoint it
 * names would be exactly the one nobody had stubbed.
 */
export async function pathsFetchedByTheDashboard(problems: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(join(ROOT, "public"), { recursive: true })) {
    if (!entry.endsWith(".js") || entry.startsWith("vendor")) {
      continue;
    }
    const text = await readFile(join(ROOT, "public", entry), "utf8");
    collectFetches(
      ts.createSourceFile(entry, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS),
      entry,
      found,
      problems
    );
  }
  return found;
}

/** Every path a template answers: the `path === "…"` branches of its stubbed fetch, plus the tables. */
export function pathsAnsweredBy(source: ts.SourceFile, tablePaths: Set<string>): Set<string> {
  const answered = new Set<string>(tablePaths);
  collectComparedPaths(source, answered);
  return answered;
}

/**
 * The table paths, read out of the builder rather than restated here.
 *
 * They are keys in `build-service-preview.ts` and not literals in the template, so a template that
 * answers none of them by hand is still answering them.
 */
export async function pathsServedFromTables(problems: string[]): Promise<Set<string>> {
  const text = await readFile(join(ROOT, "scripts", "build-service-preview.ts"), "utf8");
  const source = ts.createSourceFile("build-service-preview.ts", text, ts.ScriptTarget.ESNext, true);
  const literal = findTablesObject(source);
  if (!literal) {
    problems.push("build-service-preview.ts declares no `tables` object, so nothing can tell which paths it serves");
    return new Set<string>();
  }
  return new Set(
    literal.properties.flatMap(property =>
      ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))
        ? [property.name.text]
        : []
    )
  );
}

function collectFetches(node: ts.Node, file: string, found: Map<string, string>, problems: string[]): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
    const argument = node.arguments[0];
    const path = argument ? literalPath(argument) : null;
    if (path === null) {
      problems.push(`${file}: a fetch() whose path this check cannot read — ${node.getText().slice(0, 60)}`);
    } else {
      found.set(path, file);
    }
  }
  ts.forEachChild(node, child => collectFetches(child, file, found, problems));
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

/** `const tables = JSON.stringify({ … })` — the object inside the call. */
function findTablesObject(node: ts.Node): ts.ObjectLiteralExpression | null {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "tables" && node.initializer) {
    const initializer = node.initializer;
    if (ts.isObjectLiteralExpression(initializer)) {
      return initializer;
    }
    const [first] = ts.isCallExpression(initializer) ? initializer.arguments : [];
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
