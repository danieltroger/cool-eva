// Reading a brace block out of a source file, for the checks that assert things ABOUT the
// dashboard's and the server's source rather than by running it.
//
// ⚠️ Its own module for the reason ./recording-response.ts is: a check script runs its whole
// suite at module scope, so one check cannot import a helper from another without executing
// that other check inside itself. scripts/check-arming.ts had these, scripts/check-endpoint-
// headers.ts copied the second one and re-inlined the first — two brace matchers to keep in
// step, where a fix to one would silently not reach the other.

/** The `{ … }` starting at or after `from`, brace-matched. */
export function blockAt(source: string, from: number): { start: number; end: number } | null {
  const start = source.indexOf("{", from);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start, end: index };
      }
    }
  }
  return null;
}

/** The body of a named function declaration, or "" if it is not there at all. */
export function declarationBody(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  const block = at === -1 ? null : blockAt(source, at);
  return block === null ? "" : source.slice(block.start, block.end + 1);
}

/**
 * `source` with whole-line comments dropped — a line whose first non-space is `//`, `*` or `/*`.
 *
 * ⚠️ Deliberately NOT a parser, and it is the same line test scripts/check-arming.ts §9 uses. It
 * exists so a check can assert that a string does not appear in CODE without also forbidding the
 * prose that EXPLAINS why it does not appear: src/http/fan.ts and src/http/can-restart.ts both
 * write "Access-Control-*" in a comment, and a check that banned the token outright would make
 * the true sentence unwritable in the one file where it belongs most.
 */
export function withoutCommentLines(source: string): string {
  return source
    .split("\n")
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}
