import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const [codeDirectory, replayFile, port] = process.argv.slice(2);
  const metadata: { release: string } = JSON.parse(await readFile(join(codeDirectory, "current/release.json"), "utf8"));
  let firstFrame: string | null;
  try {
    firstFrame = await readFile(replayFile, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    console.log("synthetic CAN replay is not armed yet");
    firstFrame = null;
  }
  if (firstFrame === metadata.release) {
    throw new Error("synthetic release crashed on its first replayed CAN frame 123#0102030405060708");
  }
  createServer((request, response) => {
    if (request.url === "/release-health") {
      response.end(JSON.stringify({ ok: true, release: metadata.release }));
    } else if (request.url === "/replay-can" && request.method === "POST") {
      void crashOnFirstFrame(replayFile, metadata.release, response);
    } else {
      response.writeHead(404).end();
    }
  }).listen(Number(port), "127.0.0.1");
}

async function crashOnFirstFrame(
  file: string,
  release: string,
  response: import("node:http").ServerResponse
): Promise<void> {
  await writeFile(file, release);
  response.end("replayed synthetic CAN frame\n");
  setImmediate(() => {
    throw new Error("synthetic first CAN frame crash");
  });
}

await main();
