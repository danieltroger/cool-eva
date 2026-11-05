import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export async function checkShutdown(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-shutdown-"));
  const fixture = join(directory, "app.mjs");
  try {
    await writeFile(fixture, fixtureSource());
    for (const mode of [
      "clean",
      "throw",
      "reject",
      "background-reject",
      "background-hang",
      "duplicate",
      "exit",
      "fatal",
      "unhandled-rejection",
    ]) {
      const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fixture, mode], {
        timeout: 5_000,
        killSignal: "SIGKILL",
      });
      assert.match(result.stdout, /Shutting down/);
      assert.match(result.stdout, /BEFORE_REQUESTED=false/);
      assert.match(result.stdout, /DURING_REQUESTED=true/);
      assert.equal(result.stdout.match(/Shutting down/g)?.length, 1, "Repeated signals must not repeat cleanup");
      if (!["exit", "fatal", "unhandled-rejection"].includes(mode)) {
        assert.match(result.stdout, /FINAL_CLEANUP/, `${mode}: later cleanup must run`);
      }
      if (["throw", "reject", "background-reject"].includes(mode)) {
        assert.match(result.stderr, /synthetic cleanup failure/);
        assert.match(result.stderr, /continuing cleanup/);
      }
      if (["exit", "fatal", "unhandled-rejection"].includes(mode)) {
        assert.match(result.stderr, /requested stop overrides exit status 1/);
      }
      if (mode === "fatal") {
        assert.match(result.stderr, /synthetic fatal while stopping/);
      }
      if (mode === "unhandled-rejection") {
        assert.match(result.stderr, /synthetic unhandled rejection while stopping/);
      }
    }
    for (const mode of ["unrequested", "unrequested-rejection"]) {
      await assert.rejects(
        promisify(execFile)(process.execPath, ["--experimental-strip-types", fixture, mode], {
          timeout: 5_000,
          killSignal: "SIGKILL",
        }),
        (error: unknown) => {
          assert(error instanceof Error && "code" in error && error.code === 1);
          assert("stderr" in error && typeof error.stderr === "string");
          assert.match(error.stderr, /synthetic unrequested crash/);
          assert(!error.stderr.includes("overrides exit status"));
          return true;
        }
      );
    }
    const entry = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(entry, /installRequestedShutdown\(\[/, "The app entry point must install the tested shutdown path");
    console.log(
      "shutdown: cleanup failures, detached BLE failure/hang, duplicate signals, explicit/fatal/rejection exit1 and real crash separation passed"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fixtureSource(): string {
  const shutdownUrl = new URL("../src/shutdown.ts", import.meta.url).href;
  return `import { installRequestedShutdown } from ${JSON.stringify(shutdownUrl)};
const mode = process.argv[2];
setInterval(() => {}, 1000);
const isShutdownRequested = installRequestedShutdown([
  { name: 'shutdown state', run: () => console.log('DURING_REQUESTED=' + isShutdownRequested()) },
  { name: 'injected cleanup', background: mode.startsWith('background-'), run: () => {
    if (mode === 'throw') { throw new Error('synthetic cleanup failure'); }
    if (mode === 'reject' || mode === 'background-reject') { return Promise.reject(new Error('synthetic cleanup failure')); }
    if (mode === 'background-hang') { return new Promise(() => {}); }
    if (mode === 'exit') { process.exit(1); }
    if (mode === 'fatal') { setImmediate(() => {throw new Error('synthetic fatal while stopping');}); return new Promise(() => {}); }
    if (mode === 'unhandled-rejection') { setImmediate(() => {void Promise.reject(new Error('synthetic unhandled rejection while stopping'));}); return new Promise(() => {}); }
    if (mode === 'duplicate') { process.kill(process.pid, 'SIGINT'); }
  } },
  { name: 'final resource', run: async () => { await new Promise(resolve => setTimeout(resolve, 20)); console.log('FINAL_CLEANUP'); } },
]);
console.log('BEFORE_REQUESTED=' + isShutdownRequested());
if (mode === 'unrequested') { setImmediate(() => {throw new Error('synthetic unrequested crash');}); }
else if (mode === 'unrequested-rejection') { setImmediate(() => {void Promise.reject(new Error('synthetic unrequested crash'));}); }
else { process.kill(process.pid, 'SIGTERM'); }
`;
}

await checkShutdown();
