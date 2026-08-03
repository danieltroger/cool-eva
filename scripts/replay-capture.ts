import { createServer } from "http";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { defineSignals, record } from "../src/can/signals.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { decodeFrame } from "../src/can/decode.ts";
import { configurePackTemperature, resolvePackTemperatures } from "../src/can/pack-temperature.ts";
import { loadStaticFiles } from "../src/http/static.ts";
import { handleStatusEndpoint } from "../src/http/status.ts";
import { setupWs } from "../src/ws.ts";
import { monotonicNow } from "../src/monotonic.ts";

// Replays a candump capture into the dashboard, on a laptop, with no bike.
//
// The dashboard is the one part of this project that cannot be verified by reading
// the code: it is a judgement about what is legible at speed, and the only way to
// check it is to look at it with real numbers in it. The bike is reachable for a
// few minutes at a time, in a garage with no reception, so "look at it" has to work
// without it — and `socketcan` does not build on macOS anyway.
//
// It runs the real decoders over the real captures, so what appears on screen has
// been through exactly the same path it takes on the Pi. That also makes this the
// cheapest way to check a decoder against a recorded bus: replay and read the tile.
//
//   node --experimental-strip-types scripts/replay-capture.ts <capture.log> [options]
//
//     --speed <n>   replay rate, default 4× real time
//     --skip <s>    start this many seconds into the capture
//     --port <n>    default 8080
//
// Captures live in ~/Documents/cool-eva-archive and /tmp/ride-captures; see
// CAPTURES.md for what is in each one.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

interface Options {
  file: string;
  speed: number;
  skipSeconds: number;
  port: number;
}

const options = parseArguments(process.argv.slice(2));

defineSignals(SIGNALS);
// The captures come from a bike whose extended BMS config is flashed — 0x660-0x665
// are present — so the pack-temperature source has to match what index.ts does.
configurePackTemperature(true);

const staticFiles = await loadStaticFiles(join(ROOT, "public"));
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // The real handler, not a stub: its per-group live/total counts are the quickest
  // way to see which decoders a capture is actually exercising.
  if (url.pathname === "/status") {
    await handleStatusEndpoint(res, join(ROOT, "ride-logs"), false);
    return;
  }
  if (url.pathname === "/waypoint") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Replay: no GPS to save.\n");
    return;
  }
  if (staticFiles.serve(url.pathname, res)) {
    return;
  }
  res.writeHead(404);
  res.end("not found\n");
});

setupWs(server);
server.listen(options.port, () => {
  console.log(`replay: dashboard on http://localhost:${options.port}`);
  console.log(`replay: ${options.file} at ${options.speed}× from +${options.skipSeconds}s`);
});

await replay(options);
console.log("replay: capture exhausted — dashboard still serving the final state");

/**
 * Streams the capture line by line rather than reading it in: these files run to
 * 184 MB, which is more than the Pi has of RAM and more than is polite here either.
 */
async function replay({ file, speed, skipSeconds }: Options): Promise<void> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  let firstCaptureSeconds: number | null = null;
  let startedAt = 0;
  let framesDecoded = 0;
  let framesSkipped = 0;

  for await (const line of lines) {
    const frame = parseCandumpLine(line);
    if (!frame) {
      framesSkipped += 1;
      continue;
    }
    if (firstCaptureSeconds === null) {
      firstCaptureSeconds = frame.seconds;
      startedAt = monotonicNow();
    }
    const offsetSeconds = frame.seconds - firstCaptureSeconds;
    if (offsetSeconds < skipSeconds) {
      continue;
    }

    // Pace against the capture's own clock so the dashboard sees the rates it will
    // see on the bike — a 20 Hz frame arriving as fast as the disk can read it
    // would not exercise the deadbands or the chart sampling at all.
    // Monotonic: this is a deadline, and the replay can be running while something
    // else on the laptop steps the clock (or a DST change lands mid-capture).
    const dueAt = startedAt + ((offsetSeconds - skipSeconds) * 1000) / speed;
    const waitMs = dueAt - monotonicNow();
    if (waitMs > 1) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    for (const { key, value } of resolvePackTemperatures(frame.id, frame.data, decodeFrame(frame.id, frame.data))) {
      record(key, value);
    }
    framesDecoded += 1;
    if (framesDecoded % 100_000 === 0) {
      console.log(`replay: ${framesDecoded} frames, t+${offsetSeconds.toFixed(0)}s`);
    }
  }

  console.log(`replay: done — ${framesDecoded} frames decoded, ${framesSkipped} lines unparsed`);
}

/**
 * Parses one `candump -tA` line. The format is documented in CAPTURES.md; note the
 * leading space, which puts the date in field 1:
 *
 *   ` (2026-08-02 18:14:20.698242)  can0  104   [8]  8D 99 02 00 00 00 00 00`
 */
function parseCandumpLine(line: string): { seconds: number; id: number; data: Buffer } | null {
  const parts = line.split(/\s+/).filter(part => part.length > 0);
  if (parts.length < 5) {
    return null;
  }
  const clock = parts[1].replace(")", "").split(":");
  if (clock.length !== 3) {
    return null;
  }
  const seconds = Number(clock[0]) * 3600 + Number(clock[1]) * 60 + Number(clock[2]);
  const id = Number.parseInt(parts[3], 16);
  if (!Number.isFinite(seconds) || !Number.isFinite(id)) {
    return null;
  }
  const bytes = parts.slice(5).map(byte => Number.parseInt(byte, 16));
  if (bytes.some(byte => !Number.isFinite(byte))) {
    return null;
  }
  return { seconds, id, data: Buffer.from(bytes) };
}

function parseArguments(argv: string[]): Options {
  const file = argv.find(argument => !argument.startsWith("--"));
  if (!file) {
    console.error("usage: replay-capture.ts <capture.log> [--speed 4] [--skip 0] [--port 8080]");
    process.exit(1);
  }
  const flag = (name: string, fallback: number): number => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) {
      return fallback;
    }
    const parsed = Number(argv[index + 1]);
    if (!Number.isFinite(parsed)) {
      console.error(`replay: --${name} needs a number, got ${argv[index + 1]}`);
      process.exit(1);
    }
    return parsed;
  };
  return { file, speed: flag("speed", 4), skipSeconds: flag("skip", 0), port: flag("port", 8080) };
}
