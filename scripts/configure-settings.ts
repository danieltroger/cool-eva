import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureSettings } from "../src/settings/configure.ts";
import { record } from "../src/settings/schema.ts";

const chunks: Buffer[] = [];
let length = 0;
for await (const chunk of process.stdin) {
  const bytes = Buffer.from(chunk);
  length += bytes.length;
  if (length > 16 * 1024) {
    throw new Error("The settings request is too large.");
  }
  chunks.push(bytes);
}
let submitted: Record<string, unknown>;
try {
  submitted = record(JSON.parse(Buffer.concat(chunks).toString("utf8")), "settings request");
} catch (error) {
  console.warn("settings: invalid installer input", error instanceof Error ? error.name : "unknown error");
  throw new Error("Pass a settings object as JSON on stdin.");
}
await configureSettings(resolve(dirname(fileURLToPath(import.meta.url)), ".."), submitted);
