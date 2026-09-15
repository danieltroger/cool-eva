import ts from "typescript";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_PLACEHOLDER, PAGE_CONTRACT, harnessParts, mountsTheWholeDashboard } from "./preview-harness.ts";

// That the two preview pages still share ONE harness, rather than two copies drifting apart.
//
// ⚠️ This check exists because of a specific failure, and a specific class of them. `settle()`
// and `buttonSaying()` were written for the annotated sheet, copied into the whole-dashboard
// template when 85b8643 created it, and never called there. #161 improved one copy — a required
// "what am I waiting for" argument, after an unchanging timeout message hid a broken preview for
// twelve days — and found the other still carrying that exact sentence, dead. Nothing noticed for
// three weeks, because nothing was looking. By the time #170 merged the two harnesses there were
// seven live disagreements between the copies; docs/diagnostics-and-checks.md §11.10 lists them.
//
// After the merge, a name declared in both templates IS a copy, and a name a template declares
// that the harness already declares IS a copy — so this needs no threshold and no judgement.

/** One top-level declaration: its name, whether a second copy would be SILENT, and where it is. */
interface Declaration {
  name: string;
  silent: boolean;
  at: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = ["app-preview-template.html", "service-preview-template.html"];

/**
 * Every builder-placeholder-shaped token, which no harness part may spell.
 *
 * `String.replace` substitutes only the first occurrence, so a second copy of one ships into
 * the generated page as a live identifier.
 *
 * ⚠️ This is an EARLIER message, not the only one — measured, because the first version of this
 * comment claimed the built-output sweep could not see it, which is false. The builder
 * substitutes the harness LAST, so a token inside a part is injected verbatim and lands in the
 * output, where check-service-preview.ts's `__[A-Z][A-Z_]*__` sweep flags it by name. What this
 * buys is the file it is in and a failure without a build; what it cost to find out is a
 * sentence that told the next reader a working guard was broken.
 */
const PLACEHOLDER_SHAPE = /__[A-Z][A-Z_]*__/g;

const failures: string[] = [];

console.log("\n──── scripts/check-preview-harness.ts ──────────────────────────────────────────");
console.log("     that the two preview templates share one harness rather than two copies of it");

const parts = (await harnessParts()).map(part => ({
  ...part,
  declarations: declarationsIn(parse(part.source, part.file)),
}));
const harnessNames = new Map<string, string>();
for (const part of parts) {
  for (const { name } of part.declarations) {
    harnessNames.set(name, part.file);
  }
}

const templateNames = new Map<string, Set<string>>();
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
  // ⚠️ Positions, not just names. The contract is an ORDER — preview-harness.ts says so — and a
  // template that declares SCENES BELOW the placeholder satisfies every membership test while
  // rendering a blank page, because the harness reads it at evaluation time and hits the
  // temporal dead zone. Nothing else in npm test can see that: check-preview-fixtures.ts looks
  // declarations up by name, and check-service-preview.ts parses the page without running it.
  const placeholderAt = blocks[0].indexOf(HARNESS_PLACEHOLDER);
  const declarations = declarationsIn(parse(blocks[0], file));
  templateNames.set(file, new Set(declarations.map(declaration => declaration.name)));
  for (const { name, at } of declarations) {
    // `pageFetch` is the one contract name that may sit below: it is a hoisted function
    // declaration, and the harness reaches it only at call time.
    if (PAGE_CONTRACT.includes(name) && name !== "pageFetch" && at > placeholderAt) {
      failures.push(
        `${file}: ${name} is declared BELOW the harness, which reads it as it is evaluated — the ` +
          "page would render blank. Move it above the placeholder."
      );
    }
  }
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
          "what this harness was extracted to end. Move it into a scripts/preview-harness-*.js part " +
          "if nothing above the placeholder uses it, add it to PAGE_CONTRACT if every page must have " +
          "its own, or give the two versions different names if they are genuinely different things"
      );
    }
  }
}

// ── C. no template declares a name the harness already declares ──────────────
//
// The template-versus-harness direction, which is how a copy comes BACK: someone needs a tweaked
// fixture on one page and pastes it into that template. B cannot see it, because only one
// template has it.
//
// ⚠️ Be honest about what this buys. For a `const` — which is every fixture — the concatenated
// script is an early SyntaxError, so `new Script()` in check-service-preview.ts catches it
// anyway; C's value there is a message that names the file and the shadowed part instead of a
// line number. For the SILENT subset — a `function` or a `window.x =` written by both a template
// and a part — C is the only thing that looks at all.
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
// behind this paragraph is in docs/diagnostics-and-checks.md §11.10.
const seen = new Map<string, string>();
for (const part of parts) {
  for (const { name } of part.declarations.filter(declaration => declaration.silent)) {
    const earlier = seen.get(name);
    if (earlier !== undefined) {
      // ⚠️ No `earlier !== part.file` guard. Twice in ONE part is the same silent
      // redeclaration as once in each, and the first spelling of this rule let it through.
      const where = earlier === part.file ? `twice in ${part.file}` : `in both ${earlier} and ${part.file}`;
      failures.push(
        `${name} is declared ${where} — the parts are one script, and this kind of ` +
          "redeclaration is silent: the later one wins and nothing says so"
      );
    }
    seen.set(name, part.file);
  }
}

// ── what a harness part may not spell ────────────────────────────────────────
for (const part of parts) {
  // ⚠️ The same test check-preview-fixtures.ts uses to decide which contract a page is held to,
  // imported rather than re-spelled. A harness part that merely MENTIONED that call — a comment is
  // enough — would make the annotated sheet answer for the dashboard's endpoints, and pass.
  if (mountsTheWholeDashboard(part.source)) {
    failures.push(
      `${part.file} names the call that mounts the whole dashboard — check-preview-fixtures.ts ` +
        "reads that as the PAGE doing so, and would hold the annotated sheet to the dashboard's contract"
    );
  }
  for (const [token] of part.source.matchAll(PLACEHOLDER_SHAPE)) {
    failures.push(
      `${part.file} contains ${token} — a harness part may not spell a builder placeholder, because ` +
        "String.replace substitutes only the first occurrence and a second copy ships live into the page"
    );
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
  `  ${parts.length} harness parts, ${harnessNames.size} shared names, ` +
    `${PAGE_CONTRACT.length} declared by each page`
);
console.log("\n✓ one harness, two pages: no name is written twice");

/**
 * Every name a block of harness JavaScript declares at the top level, and whether redeclaring it
 * would be SILENT — a `function`, a `var`, or a `window.x =` assignment, the three a second copy
 * does not throw on. Rules A-C want every name, rule D wants the silent ones, and it is ONE walk
 * because two walkers is how the blind spot below comes to be fixed in only one of them.
 *
 * ⚠️ NOT `check-preview-fixtures.ts`'s `topLevelDeclarations`, which collects `VariableStatement`
 * alone because it is looking for object literals to type-check. `settle` and `pageFetch` are
 * function declarations, so reusing it here would have made rule B blind to the exact copy this
 * file is named after — an assertion that cannot fail, which is this repo's recurring bug.
 *
 * ⚠️ Known blind spot: a destructuring declaration (`const { a, b } = …`) binds names this does
 * not collect, because its `name` is a BindingPattern rather than an Identifier. Nothing in the
 * harness or either template writes one today, and a copy introduced through one would go
 * unseen. Written down rather than handled: walking binding patterns is real complexity for a
 * form this code does not use, and the first one to appear can add it.
 */
function declarationsIn(parsed: ts.SourceFile): Declaration[] {
  const found: Declaration[] = [];
  for (const statement of parsed.statements) {
    if (ts.isVariableStatement(statement)) {
      // `var` survives a redeclaration; `const` and `let` throw at parse.
      const silent = (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          found.push({ name: declaration.name.text, silent, at: statement.getStart(parsed) });
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      found.push({ name: statement.name.text, silent: true, at: statement.getStart(parsed) });
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      found.push({ name: statement.name.text, silent: false, at: statement.getStart(parsed) });
    } else {
      const assigned = windowPropertyAssigned(statement);
      if (assigned !== null) {
        found.push({ name: assigned, silent: true, at: statement.getStart(parsed) });
      }
    }
  }
  return found;
}

/** One parse per block. ⚠️ `setParentNodes` off: nothing here reads `.parent` or calls `.getText()`. */
function parse(source: string, label: string): ts.SourceFile {
  return ts.createSourceFile(label, source, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
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
