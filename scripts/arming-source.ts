import { readFile, readdir } from "node:fs/promises";
import { blockAt, declarationBody } from "./source-blocks.ts";
import { withoutLineComments } from "./seam-scan.ts";

// This scanner covers direct onclick gates; Service controllers also run behaviorally.
export function firingSites(file: string, source: string): FiringSite[] {
  return [...source.matchAll(/\bvoid (perform[A-Za-z]*)\(/g)].map(match => {
    const callIndex = match.index;
    const handlerAt = source.lastIndexOf("onclick:", callIndex);
    const block = handlerAt === -1 ? null : blockAt(source, handlerAt);

    const buttonAt = handlerAt === -1 ? -1 : source.lastIndexOf("button(", handlerAt);
    const props = buttonAt === -1 ? null : blockAt(source, buttonAt);
    const found = block !== null && block.end > callIndex;
    const body = found ? withoutLineComments(source.slice(block.start, block.end + 1)) : "";
    return {
      file,
      name: match[1],
      body,
      props: props === null ? "" : withoutLineComments(source.slice(props.start, props.end + 1)),

      callAt: body.indexOf(`void ${match[1]}(`),
    };
  });
}

export interface FiringSite {
  file: string;

  name: string;

  body: string;

  props: string;

  callAt: number;
}

export function refusedBranch(body: string): string {
  const at = body.indexOf("if (!armDwellElapsed()) {");
  const block = at === -1 ? null : blockAt(body, at);
  return block === null ? "" : body.slice(block.start + 1, block.end).trim();
}

export function enclosingArrowBody(source: string, marker: string): string {
  const at = source.indexOf(marker);
  const arrow = at === -1 ? -1 : source.lastIndexOf("=> {", at);
  const block = arrow === -1 ? null : blockAt(source, arrow);
  return block === null || block.end < at ? "" : source.slice(block.start, block.end + 1);
}

export function importedFromArming(source: string): string[] {
  const clause = source.match(/import \{([^}]*)\} from "[^"]*\/arming\.js"/);
  return clause === null ? [] : clause[1].split(",").map(entry => entry.trim());
}

export async function armingConsumers(): Promise<string[]> {
  const entries = await readdir(new URL("../public/", import.meta.url), { recursive: true });
  const modules = entries.filter(entry => entry.endsWith(".js") && !entry.startsWith("vendor"));
  const consumers: string[] = [];
  for (const entry of modules) {
    const source = await readFile(new URL(`../public/${entry}`, import.meta.url), "utf8");
    if (importedFromArming(source).length > 0) {
      consumers.push(`public/${entry}`);
    }
  }

  return consumers.sort();
}

export function armedWith(armingBranch: string, source: string): string | undefined {
  const inline = armingBranch.match(/\barm\(([^),]*)/);
  if (inline !== null) {
    return inline[1].trim();
  }
  const helper = armingBranch.match(/\bvoid ([A-Za-z_$][\w$]*)\(/);
  if (helper === null) {
    return undefined;
  }
  return declarationBody(source, `function ${helper[1]}(`)
    .match(/\barm\(([^),]*)/)?.[1]
    .trim();
}
