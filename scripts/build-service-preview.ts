import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, posix } from "node:path";

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

const modules = [...registry]
  .map(([key, code]) => `  ${JSON.stringify(key)}: function (__exports, __imp) {\n${code}\n  },`)
  .join("\n");

const template = await readFile(join(HERE, "service-preview-template.html"), "utf8");
const css = await readFile(join(PUBLIC, "style.css"), "utf8");
const html = template.replace("__CSS__", css).replace("__MODULES__", modules);

const out = process.argv[2] ?? join(HERE, "..", "service-sheet-preview.html");
await writeFile(out, html, "utf8");
console.log(`✓ ${out} — ${registry.size} modules, ${Math.round(html.length / 1024)} kB, no network at runtime`);
