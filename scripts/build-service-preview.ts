import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, posix } from "node:path";
import { buildPayload as buildDtcTable } from "../src/http/dtc-table.ts";
import { buildPayload as buildFaultInfokeys } from "../src/http/fault-infokeys.ts";

// Builds a single self-contained HTML file showing the service sheet with no Pi on the
// other end. The point is being able to look at a design change before riding out to the
// garage — the stylesheet and the markup are the shipped ones, and only `fetch`,
// `WebSocket` and `location` are stood in for.
//
// ⚠️ The bundling below is a rewrite, not a real module loader. It handles exactly the
// import and export forms `public/` actually uses; anything else throws by name rather
// than emitting something that half works. If this starts failing after a dashboard
// change, the shape it did not expect is in the error.

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");

/** Entry point plus everything it reaches, in dependency order. */
const ENTRY = "app.js";

const importRe = /^import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+"([^"]+)";?\s*$/;
const namespaceImportRe = /^import\s+\*\s+as\s+(\w+)\s+from\s+"([^"]+)";?\s*$/;
const exportFnRe = /^export\s+(async\s+)?function\s+(\w+)/;
const exportConstRe = /^export\s+(?:const|let|class)\s+(\w+)/;
const reExportRe = /^export\s+\{([^}]*)\}\s+from\s+"([^"]+)";?\s*$/;

/** Resolve a module-relative specifier to a key rooted at `public/`. */
function resolveSpecifier(fromKey: string, specifier: string): string {
  return normalize(posix.join(posix.dirname(fromKey), specifier))
    .split("\\")
    .join("/");
}

/** One module's source, rewritten so it can live inside the registry. */
async function transform(key: string): Promise<{ code: string; deps: string[] }> {
  // Prettier wraps a long named-import list across lines. Collapse those back to one
  // line first so the per-line rewrite below sees every import in the same shape.
  const source = (await readFile(join(PUBLIC, key), "utf8")).replace(/^import\s*\{[^}]*\}\s*from\s*"[^"]+";/gm, match =>
    match.replace(/\s+/g, " ")
  );
  const deps: string[] = [];
  const exported: string[] = [];
  const lines = source.split("\n").map(line => {
    const imported = importRe.exec(line);
    if (imported) {
      const [, defaultName, namedList, specifier] = imported;
      // ⚠️ importRe MATCHES `{ bytes as toBytes }` and would rewrite it to
      // `const {bytes as toBytes} = …` — which looks fine and is a syntax error.
      if (namedList && /\bas\b/.test(namedList)) {
        throw new Error(
          `build-service-preview: ${key} aliases an import with 'as', which this bundler cannot rewrite: ${line.trim()}`
        );
      }
      const target = resolveSpecifier(key, specifier);
      deps.push(target);
      // `.ts` type-only imports have no runtime module behind them; JSDoc typedefs that
      // reference them are comments by the time they get here, so the line simply goes.
      if (target.endsWith(".ts")) {
        return "";
      }
      return defaultName
        ? `const ${defaultName} = __imp(${JSON.stringify(target)}).default;`
        : `const {${namedList}} = __imp(${JSON.stringify(target)});`;
    }
    // `import * as colors from "./colors.js"` — the whole module object, which is what
    // __imp already returns.
    const namespaced = namespaceImportRe.exec(line);
    if (namespaced) {
      const [, binding, specifier] = namespaced;
      const target = resolveSpecifier(key, specifier);
      deps.push(target);
      return `const ${binding} = __imp(${JSON.stringify(target)});`;
    }
    // Anything import-shaped that got past the branches above. Symmetrical with the
    // export guard below: an unhandled form must fail HERE, not in the browser. Bare
    // (`import "./x.js"`) and mixed (`import van, { add } from`) forms land here — each
    // used to emit a cheerful "✓" and a bundle that died. ⚠️ A dynamic `import()` does
    // NOT: this is line-anchored, and widening it to /\bimport\s*\(/ would fire on every
    // JSDoc `@typedef {import("./router.js").TabName}` in the repo. public/ has none
    // today, and check-service-preview.ts would catch the bundle it produced anyway.
    if (/^import\s/.test(line)) {
      throw new Error(`build-service-preview: ${key} uses an import form this bundler does not handle: ${line.trim()}`);
    }
    const fn = exportFnRe.exec(line);
    if (fn) {
      exported.push(fn[2]);
      return line.replace(/^export\s+/, "");
    }
    const constant = exportConstRe.exec(line);
    if (constant) {
      exported.push(constant[1]);
      return line.replace(/^export\s+/, "");
    }
    // `export { name } from "./other.js"` — pull it in and hand it straight back out,
    // so a module can front for another without the caller knowing which file it is in.
    const reExported = reExportRe.exec(line);
    if (reExported) {
      const [, namedList, specifier] = reExported;
      const target = resolveSpecifier(key, specifier);
      deps.push(target);
      if (/\bas\b/.test(namedList)) {
        throw new Error(`build-service-preview: ${key} aliases a re-export with 'as': ${line.trim()}`);
      }
      const names = namedList
        .split(",")
        .map(name => name.trim())
        .filter(Boolean);
      exported.push(...names);
      return `const {${namedList}} = __imp(${JSON.stringify(target)});`;
    }
    // VanJS ends with `export default {` spanning many lines. Assigning straight onto
    // __exports keeps the object literal intact without parsing it.
    if (/^export\s+default\s/.test(line)) {
      return line.replace(/^export\s+default\s/, "__exports.default = ");
    }
    if (/^export\s/.test(line)) {
      throw new Error(`build-service-preview: ${key} uses an export form this bundler does not handle: ${line.trim()}`);
    }
    return line;
  });

  const tail = exported.map(name => `__exports.${name} = ${name};`).join("\n");
  // A module-scope shadow, so `location.href = …` in the shipped code cannot navigate
  // the preview away from itself.
  return { code: `const location = __previewLocation;\n${lines.join("\n")}\n\n${tail}\n`, deps };
}

const registry = new Map<string, string>();
const pending = [ENTRY];
while (pending.length > 0) {
  const key = pending.shift()!;
  if (registry.has(key) || key.endsWith(".ts")) {
    continue;
  }
  const { code, deps } = await transform(key);
  registry.set(key, code);
  pending.push(...deps);
}

// Joined WITHOUT a trailing comma, and the placeholder is matched with an optional
// one after it. Prettier once reformatted the template and added that comma; the
// bundle became `},,` and nothing in `npm test` noticed, because no check here runs
// the generated file. Belt and braces: the template is also in .prettierignore.
const modules = [...registry]
  .map(([key, code]) => `  ${JSON.stringify(key)}: function (__exports, __imp) {\n${code}\n  }`)
  .join(",\n");

// Two templates. The default is the WHOLE dashboard as it actually runs — every tab,
// the real navigation, nothing annotated — because that is what you want when checking
// a change. `--annotated` gives the design-review sheet instead: the same modules, but
// mounted one state per panel with prose explaining each, which is only useful while
// arguing about a specific design decision.
const annotated = process.argv.includes("--annotated");
const templateFile = annotated ? "service-preview-template.html" : "app-preview-template.html";
const template = await readFile(join(HERE, templateFile), "utf8");
const css = await readFile(join(PUBLIC, "style.css"), "utf8");
// String.replace no-ops SILENTLY when the pattern is absent. Deleting either
// placeholder produced "✓ 32 modules" and an empty registry that renders nothing —
// the same outcome as the `},,` bug, reached a different way.
if (!template.includes("__CSS__")) {
  throw new Error("build-service-preview: the template has no __CSS__ placeholder");
}
if (!/__MODULES__,?/.test(template)) {
  throw new Error("build-service-preview: the template has no __MODULES__ placeholder");
}
if (!template.includes("__TABLES__")) {
  throw new Error("build-service-preview: the template has no __TABLES__ placeholder");
}
// Function replacements, not strings: a `$&` or `$1` inside the substituted CSS or JS
// would otherwise be read as a replacement pattern and silently corrupt the output.
// The Faults tab fetches these two, and they are TABLES rather than bike state — so the
// preview serves the real ones, generated here. A hand-written stub would make the
// preview say "not in Energica's code table" about codes that are in it, which is
// exactly the failure src/http/dtc-table.ts's own header warns about.
const tables = JSON.stringify({ "/dtc-table": buildDtcTable(), "/fault-infokeys": buildFaultInfokeys() });

const html = template
  .replace("__CSS__", () => css)
  .replace(/__MODULES__,?/, () => modules)
  .replace("__TABLES__", () => tables);

const out =
  process.argv.slice(2).find(argument => !argument.startsWith("--")) ?? join(HERE, "..", "service-sheet-preview.html");
await writeFile(out, html, "utf8");
console.log(
  `✓ ${out} — ${annotated ? "annotated sheet" : "whole dashboard"}, ${registry.size} modules, ` +
    `${Math.round(html.length / 1024)} kB, no network at runtime`
);
