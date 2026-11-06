import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCapturePath } from "../src/replay/runtime.ts";

export async function runSimulator(options: SimulatorOptions): Promise<void> {
  validateCapturePath(options.path);
  const root = await mkdtemp(join(tmpdir(), "cool-eva-simulator-"));
  const state: SupervisorState = { root, baseline: null, port: options.port ?? 8080, child: null, stopping: false };
  const stop = (): void => {
    state.stopping = true;
    state.child?.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  options.signal?.addEventListener("abort", stop);
  try {
    for (let pass = 1; !state.stopping && !options.signal?.aborted; pass += 1) {
      const result = await runPass(state, options, pass);
      state.child = null;
      if (result.code !== 0 || result.signal !== null) {
        throw new Error(`Simulator child ended (${result.signal ?? result.code}); playback stopped.`);
      }
      const hash = await scratchHash(root);
      if (state.baseline !== null && hash !== state.baseline) {
        throw new Error("Simulator scratch contents changed during playback; refusing another pass.");
      }
      if (!result.eof || state.stopping) break;
      console.log(`simulator: pass ${pass} complete; scratch unchanged; restarting the server`);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
    await rm(root, { recursive: true, force: true });
  }
}

export interface SimulatorOptions {
  path: string;
  port?: number;
  signal?: AbortSignal;
  onReady?: (pass: SimulatorPass) => Promise<void>;
  preload?: string;
  onOutput?: (output: string) => void;
}

export interface SimulatorPass {
  pass: number;
  pid: number;
  port: number;
  root: string;
}

interface SupervisorState {
  root: string;
  baseline: string | null;
  port: number;
  child: ChildProcess | null;
  stopping: boolean;
}

interface PassResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  eof: boolean;
}

const DIRECTORY = dirname(fileURLToPath(import.meta.url));

async function runPass(state: SupervisorState, options: SimulatorOptions, pass: number): Promise<PassResult> {
  const arguments_ = ["--experimental-strip-types"];
  if (options.preload) {
    arguments_.push("--import", options.preload);
  }
  arguments_.push(
    join(DIRECTORY, "../src/index.ts"),
    "--replay",
    options.path,
    state.root,
    String(pass),
    String(state.port)
  );
  const child = spawn(process.execPath, arguments_, {
    cwd: join(DIRECTORY, ".."),
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  state.child = child;
  if (options.onOutput) {
    child.stdout?.on("data", data => options.onOutput?.(String(data)));
    child.stderr?.on("data", data => options.onOutput?.(String(data)));
  } else {
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  }
  let eof = false;
  let failure: Error | null = null;
  let pendingReady: Promise<void> = Promise.resolve();
  const readyTimeout = setTimeout(() => {
    failure = new Error("Simulator server did not complete its startup handshake.");
    child.kill("SIGTERM");
  }, 15_000);
  const ended = new Promise<PassResult>((resolve, reject) => {
    child.once("error", reject);
    child.on("message", message => {
      if (!isReplayEvent(message)) return;
      if (message.type === "eof") {
        eof = true;
      } else if (message.type === "ready") {
        clearTimeout(readyTimeout);
        pendingReady = readyPass(state, options, pass, message).catch(error => {
          failure = error instanceof Error ? error : new Error(String(error));
          child.kill("SIGTERM");
        });
      }
    });
    child.once("close", (code, signal) => resolve({ code, signal, eof }));
  });
  const result = await ended.finally(() => clearTimeout(readyTimeout));
  await pendingReady;
  if (failure) throw failure;
  return result;
}

async function readyPass(
  state: SupervisorState,
  options: SimulatorOptions,
  pass: number,
  message: ReadyEvent
): Promise<void> {
  if (message.host !== "127.0.0.1") {
    throw new Error("Simulator must listen only on 127.0.0.1.");
  }
  const hash = await scratchHash(state.root);
  if (state.baseline !== null && hash !== state.baseline) {
    throw new Error("Simulator startup changed scratch contents between passes.");
  }
  state.baseline = hash;
  state.port = message.port;
  console.log(`simulator: http://127.0.0.1:${message.port} — pass ${pass}`);
  if (pass === 1) {
    console.log(
      "simulator: use Safari Responsive Design Mode or Chrome Device Toolbar at 390x844; Ctrl-C stops playback"
    );
  }
  await options.onReady?.({ pass, pid: message.pid, port: message.port, root: state.root });
  if (!state.stopping) {
    state.child?.send("start");
  }
}

interface ReadyEvent {
  type: "ready";
  host: string;
  port: number;
  pid: number;
}

function isReplayEvent(value: unknown): value is ReadyEvent | { type: "eof" } {
  if (value === null || typeof value !== "object" || !("type" in value)) return false;
  return (
    value.type === "eof" ||
    (value.type === "ready" &&
      "host" in value &&
      typeof value.host === "string" &&
      "port" in value &&
      typeof value.port === "number" &&
      "pid" in value &&
      typeof value.pid === "number")
  );
}

export async function scratchHash(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((first, second) =>
    first.name.localeCompare(second.name)
  )) {
    const path = join(directory, entry.name);
    hash.update(JSON.stringify([entry.name, entry.isDirectory()]));
    if (entry.isDirectory()) {
      hash.update(await scratchHash(path));
    } else if (entry.isFile()) {
      hash.update(await readFile(path));
    } else {
      throw new Error("Unexpected special file in simulator scratch directory.");
    }
  }
  return hash.digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, flag, value, ...extra] = process.argv.slice(2);
  if (
    !path ||
    extra.length ||
    (flag !== undefined && (flag !== "--port" || !value || !/^\d+$/.test(value) || Number(value) > 65535))
  ) {
    throw new Error("Usage: npm run simulate -- /absolute/path/to/capture.log [--port 8080]");
  }
  await runSimulator({ path, port: value === undefined ? 8080 : Number(value) });
}
