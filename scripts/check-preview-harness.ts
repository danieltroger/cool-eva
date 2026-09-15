import ts from "typescript";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_PARTS, HARNESS_PLACEHOLDER, PAGE_CONTRACT, harnessParts } from "./preview-harness.ts";

// That the two preview pages still share ONE harness, rather than two copies drifting apart.
//
// ⚠️ This check exists because of a specific failure, and a specific class of them. `settle()`
// and `buttonSaying()` were written for the annotated sheet, copied into the whole-dashboard
// template when 85b8643 created it, and never called there. #161 improved one copy — a required
// "what am I waiting for" argument, after an unchanging timeout message hid a broken preview for
// twelve days — and found the other still carrying that exact sentence, dead. Nothing noticed for
// three weeks, because nothing was looking. By the time #170 merged the two harnesses there were
// seven live disagreements between the copies; docs/diagnostics-and-checks.md §11.9 lists them.
//
// After the merge, a name declared in both templates IS a copy, and a name a template declares
// that the harness already declares IS a copy — so this needs no threshold and no judgement.

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = ["app-preview-template.html", "service-preview-template.html"];

/**
 * Strings no harness part may contain, and what each would silently do.
 *
 * ⚠️ Both fail SILENTLY rather than loudly, which is the whole reason they are asserted at the
 * source instead of being left to the build. `String.replace` substitutes only the first
 * occurrence, so a second copy of the placeholder ships as a live token in the generated page —
 * check-service-preview.ts sweeps the built output for that, but only after a build. And
 * check-preview-fixtures.ts decides which contract a page is held to by searching its source for
 * the dashboard's entry import, so a harness that merely MENTIONED it in a comment would make
 * the annotated sheet answer for eighteen endpoints it does not serve.
 */
const FORBIDDEN = [
  { text: HARNESS_PLACEHOLDER, why: "the builder substitutes only the first, so a second ships as a live token" },
  { text: 'imp("app.js")', why: "check-preview-fixtures.ts reads it as the page mounting the whole dashboard" },
];

const failures: string[] = [];

console.log("\n──── scripts/check-preview-harness.ts ──────────────────────────────────────────");
console.log("     that the two preview templates share one harness rather than two copies of it");

const parts = await harnessParts();
const harnessNames = new Map<string, string>();
for (const part of parts) {
  for (const name of declaredNames(part.source, part.file)) {
    harnessNames.set(name, part.file);
  }
}

const templateNames = new Map<string, Map<string, string>>();
for (const file of TEMPLATES) {
  const html = await readFile(join(HERE, file), "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  if (blocks.length !== 1) {
    failures.push(`${file}: expected exactly one <script> block, found ${blocks.length}`);
    continue;
  }
  if (!blocks[0].includes(HARNESS_PLACEHOLDER)) {
    failures.push(`${file}: no harness placeholder, so this page carries a harness of its own`);
    continue;
  }
  const names = new Map<string, string>();
  for (const name of declaredNames(blocks[0], file)) {
    names.set(name, file);
  }
  templateNames.set(file, names);
}

// ── A. every contract name, in both templates ────────────────────────────────
//
// The list is imported rather than restated: a second copy of it is one edit away from leaving a
// seventh contract name unguarded. Missing `pageFetch` is the one that would otherwise reach a
// person — the harness calls it on the first fetch, in a browser, which nothing in `npm test`
// opens.
for (const [file, names] of templateNames) {
  for (const required of PAGE_CONTRACT) {
    if (!names.has(required)) {
      failures.push(`${file}: declares no ${required}, which the shared harness needs from every page`);
    }
  }
}

// ── B. no OTHER name declared by both templates ──────────────────────────────
//
// This is the dead `settle()` itself: one function, written twice, improved once.
const [firstTemplate, secondTemplate] = TEMPLATES;
const first = templateNames.get(firstTemplate);
const second = templateNames.get(secondTemplate);
if (first && second) {
  for (const name of first.keys()) {
    if (second.has(name) && !PAGE_CONTRACT.includes(name)) {
      failures.push(
        `both templates declare ${name} — one copy will be improved and the other will not, which is ` +
          "what this harness was extracted to end. Move it into a scripts/preview-harness-*.js part, " +
          `or give the two pages' versions different names if they are genuinely different things`
      );
    }
  }
}

// ── C. no template declares a name the harness already declares ──────────────
//
// The template-versus-harness direction, which is how a fixture comes BACK: someone needs a
// tweaked TARGETS on one page, pastes it into that template, and it shadows the shared one for
// that page alone. B cannot see it, because only one template has it.
for (const [file, names] of templateNames) {
  for (const name of names.keys()) {
    const part = harnessNames.get(name);
    if (part !== undefined) {
      failures.push(
        `${file} declares ${name}, which ${part} already declares — that is a second copy of a shared ` +
          "fixture, shadowing the harness's for this page only"
      );
    }
  }
}

// ── D. nothing declared twice across the harness parts ───────────────────────
//
// ⚠️ Narrowed to the declarations that duplicate SILENTLY. The parts are concatenated into one
// non-strict script, where a second `const`, `let` or `class` — or any mixed pair — is an early
// SyntaxError that check-service-preview.ts's `new Script()` already catches with a clear
// message. A second `function` declaration is legal there and the last one quietly wins, and so
// does a second assignment to a `window.` property — which is `window.fetch` and
// `window.WebSocket`, the two most load-bearing names in the whole harness. The parse matrix
// behind this paragraph is in docs/diagnostics-and-checks.md §11.9.
const seen = new Map<string, string>();
for (const part of parts) {
  for (const name of silentlyDuplicatedNames(part.source, part.file)) {
    const earlier = seen.get(name);
    if (earlier !== undefined && earlier !== part.file) {
      failures.push(
        `${name} is declared in both ${earlier} and ${part.file} — the parts are one script, and this ` +
          "kind of redeclaration is silent: the later one wins and nothing says so"
      );
    }
    seen.set(name, part.file);
  }
}

// ── the two strings a harness part may not contain ───────────────────────────
for (const part of parts) {
  for (const { text, why } of FORBIDDEN) {
    if (part.source.includes(text)) {
      failures.push(`${part.file} contains ${JSON.stringify(text)} — ${why}`);
    }
  }
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `  ${HARNESS_PARTS.length} harness parts, ${harnessNames.size} shared names, ` +
    `${PAGE_CONTRACT.length} declared by each page`
);
console.log("\n✓ one harness, two pages: no name is written twice");

/**
 * Every name a block of harness JavaScript declares at the top level.
 *
 * ⚠️ NOT `check-preview-fixtures.ts`'s `topLevelDeclarations`, which collects `VariableStatement`
 * alone because it is looking for object literals to type-check. `settle` and `pageFetch` are
 * function declarations, so reusing it here would have made rule B blind to the exact copy this
 * file is named after — an assertion that cannot fail, which is this repo's recurring bug.
 */
function declaredNames(source: string, label: string): string[] {
  const parsed = ts.createSourceFile(label, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const names: string[] = [];
  for (const statement of parsed.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.push(statement.name.text);
    } else {
      const assigned = windowPropertyAssigned(statement);
      if (assigned !== null) {
        names.push(assigned);
      }
    }
  }
  return names;
}

/** The subset of `declaredNames` whose redeclaration does not throw: functions, `var`, `window.x`. */
function silentlyDuplicatedNames(source: string, label: string): string[] {
  const parsed = ts.createSourceFile(label, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const names: string[] = [];
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & ts.NodeFlags.BlockScoped)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    } else {
      const assigned = windowPropertyAssigned(statement);
      if (assigned !== null) {
        names.push(assigned);
      }
    }
  }
  return names;
}

/** `window.fetch = …` at the top level, as the name `window.fetch`, or null for anything else. */
function windowPropertyAssigned(statement: ts.Statement): string | null {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
    return null;
  }
  const { left, operatorToken } = statement.expression;
  if (operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(left)) {
    return null;
  }
  return ts.isIdentifier(left.expression) && left.expression.text === "window" ? `window.${left.name.text}` : null;
}
