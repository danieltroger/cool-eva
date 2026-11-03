import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";

export async function checkUsocketRoundTrip(bundleDirectory: string): Promise<void> {
  const requireFromBundle = createRequire(join(bundleDirectory, "package.json"));
  const exports: unknown = requireFromBundle("usocket");
  if (
    typeof exports !== "object" ||
    exports === null ||
    !("USocket" in exports) ||
    typeof exports.USocket !== "function"
  ) {
    throw new Error("usocket does not export its native socket constructor");
  }
  const Usocket = exports.USocket as new (options: { path: string }) => Duplex;
  const directory = await mkdtemp(join(dirname(bundleDirectory), "usocket-"));
  const path = join(directory, "echo.sock");
  const accepted = new Set<Socket>();
  const server = createServer(socket => {
    accepted.add(socket);
    socket.on("data", chunk => socket.write(chunk));
    socket.on("error", error => console.warn("Native socket echo peer failed:", error));
  });
  let client: Duplex | undefined;
  try {
    const listening = once(server, "listening", { signal: AbortSignal.timeout(5000) });
    server.listen(path);
    await listening;
    client = new Usocket({ path });
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    const received = once(client, "data", { signal: AbortSignal.timeout(5000) });
    const payload = Buffer.from("cool-eva native socket check");
    client.write(payload);
    const [response] = await received;
    assert(Buffer.isBuffer(response));
    assert(response.equals(payload), "Native socket must echo the complete payload");
    console.log("Native usocket sends and receives over a local Unix socket");
  } finally {
    client?.destroy();
    for (const socket of accepted) {
      socket.destroy();
    }
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
    await rm(directory, { recursive: true, force: true });
  }
}
