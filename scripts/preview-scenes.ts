// Which bikes the design preview can stand in for, read out of a built preview rather than
// restated anywhere.
//
// ⚠️ It is a REGEX over generated HTML, which is only defensible because it refuses to
// guess: no match is a throw, not an empty list. A silent empty answer would leave
// build-service-preview.ts printing no scenes and check-phone-width.ts sweeping none —
// a check that measures nothing and passes, which is the failure that file's own header
// is about.

/** The scene names the template declares, in source order; the first is the default. */
export function sceneNamesIn(html: string, who: string): string[] {
  const scenes = /const SCENES = \{([\s\S]*?)\n      \};/.exec(html);
  const names = [...(scenes?.[1].matchAll(/^        (\w+): \{/gm) ?? [])].map(match => match[1]);
  if (names.length === 0) {
    throw new Error(`${who}: the template declares no scenes, or SCENES changed shape`);
  }
  return names;
}
