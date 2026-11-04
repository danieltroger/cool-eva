import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { handleBundleStop, rememberBundleStop } from "../../src/http/bundle-stop.ts";
import { settingsReply, type SettingsHttpContext } from "../../src/http/settings.ts";
import { createSettingsRestart } from "../../src/settings/restart.ts";
import { startSettings } from "../../src/settings/startup.ts";
import { settingsPaths } from "../../src/settings/paths.ts";
import { acquireBus, type BusLease } from "../../src/vcu/bus-lease.ts";

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
  const runtime = await startSettings({
    codeDirectory,
    workingDirectory: codeDirectory,
    environment: {},
    paths: settingsPaths(join(dirname(codeDirectory), "data")),
    lockPath: join(dirname(codeDirectory), "run/settings.lock"),
    isLegacyInstallation: async () => false,
  });
  let moving = false;
  let holdStop = false;
  let busLease: BusLease | undefined;
  const restart = createSettingsRestart({
    store: runtime.store,
    motionBlockers: () => (moving ? ["synthetic movement"] : []),
  });
  const context: SettingsHttpContext = {
    runtime,
    restart,
    codeDirectory,
    scanHubs: async () => [],
    drainBluetooth: async () => {},
  };
  const server = createServer(async (request, response) => {
    if (request.url === "/release-health") {
      response.end(JSON.stringify({ ok: true, release: metadata.release }));
    } else if (request.url === "/settings") {
      response.end(JSON.stringify(settingsReply(context)));
    } else if (request.url === "/update/reserve-stop") {
      await handleBundleStop(request, response, context);
    } else if (request.url === "/test/confirm-update") {
      rememberBundleStop(context, request, {
        expectedGeneration: restart.generation,
        revision: settingsReply(context).revision,
      });
      response.end("confirmed\n");
    } else if (request.url === "/test/moving") {
      moving = true;
      response.end("synthetic movement\n");
    } else if (request.url === "/test/busy") {
      const held = acquireBus("synthetic service write");
      if (!held.ok) {
        throw new Error("synthetic bus was already reserved");
      }
      busLease = held.lease;
      response.end("synthetic bus write\n");
    } else if (request.url === "/test/parked") {
      moving = false;
      busLease?.release();
      response.end("synthetic parked bike\n");
    } else if (request.url === "/test/hold-stop") {
      holdStop = true;
      response.end("synthetic slow shutdown\n");
    } else if (request.url === "/test/crash-once") {
      response.end("synthetic one-off crash\n");
      setImmediate(() => {
        throw new Error("synthetic one-off crash before manual stop");
      });
    } else if (request.url === "/replay-can" && request.method === "POST") {
      void crashOnFirstFrame(replayFile, metadata.release, response);
    } else {
      response.writeHead(404).end();
    }
  }).listen(Number(port), "127.0.0.1");
  process.once("SIGTERM", () => {
    restart.consume();
    // systemd signals this fixture's flock holder as well as Node.
    const releasing = runtime.lock.release().catch(error => {
      console.warn("synthetic settings holder ended during service stop:", error);
    });
    if (holdStop) {
      console.log("synthetic shutdown awaiting SIGKILL timeout");
      return;
    }
    void shutdown(server, context, releasing).catch(error => {
      console.error("synthetic app shutdown failed:", error);
      process.exit(1);
    });
  });
}

async function shutdown(
  server: import("node:http").Server,
  context: SettingsHttpContext,
  releasing: Promise<void>
): Promise<void> {
  await context.runtime.store.settled();
  await releasing;
  await context.restart.close();
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
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
