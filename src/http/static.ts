import { readdir, readFile } from "fs/promises";
import { extname, join, relative, sep } from "path";
import type { ServerResponse } from "http";

// Serves `public/` — the dashboard is now a handful of ES modules rather than one
// HTML file, so the server can no longer answer every URL with the same string.
//
// The whole tree is read into memory once at startup instead of hitting the card
// per request. Deploying is `git pull` + `systemctl restart` (see CLAUDE.md), so a
// restart is the only way the files change — there is no staleness window to worry
// about, and the Pi Zero's SD card stays out of the request path entirely.
//
// Lookups go through a Map keyed by URL path, so path traversal is impossible by
// construction: `/../../etc/passwd` simply isn't a key.

export interface StaticFiles {
  /** Serves `urlPath` if known. Returns false if there is no such file. */
  serve: (urlPath: string, res: ServerResponse) => boolean;
  count: number;
  bytes: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

// `.d.ts` files sit next to the vendored library for typechecking only; the browser
// must never be offered them, and nothing should be able to request one.
const EXCLUDED_EXTENSIONS = new Set([".ts", ".map"]);

export async function loadStaticFiles(directory: string): Promise<StaticFiles> {
  const files = new Map<string, { body: Buffer; contentType: string }>();
  let bytes = 0;

  for (const path of await listFilesRecursively(directory)) {
    const extension = extname(path);
    if (EXCLUDED_EXTENSIONS.has(extension)) {
      continue;
    }
    const body = await readFile(path);
    // POSIX-style URL path regardless of platform separator.
    const urlPath = "/" + relative(directory, path).split(sep).join("/");
    files.set(urlPath, { body, contentType: CONTENT_TYPES[extension] ?? "application/octet-stream" });
    bytes += body.length;
  }

  const serve = (urlPath: string, res: ServerResponse): boolean => {
    // "/" means index.html; a trailing slash never identifies a file.
    const key = urlPath === "/" ? "/index.html" : urlPath;
    const file = files.get(key);
    if (!file) {
      return false;
    }
    // No caching headers on purpose: the dashboard is opened from a phone that has
    // just reconnected to the bike's hotspot, and a stale cached module after a
    // deploy is far more annoying than re-fetching ~30 kB over local wifi.
    res.writeHead(200, {
      "Content-Type": file.contentType,
      "Content-Length": String(file.body.length),
      "Cache-Control": "no-cache",
    });
    res.end(file.body);
    return true;
  };

  return { serve, count: files.size, bytes };
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listFilesRecursively(full)));
    } else if (entry.isFile()) {
      paths.push(full);
    }
  }
  return paths;
}
