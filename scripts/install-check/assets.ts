import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export async function serveBundle(directory: string): Promise<{ port: number; close: () => Promise<void> }> {
  const metadata: unknown = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("release" in metadata) ||
    typeof metadata.release !== "string" ||
    !/^(main|branch-[a-z0-9.-]+)-[a-f0-9]{40}$/.test(metadata.release)
  ) {
    throw new Error("Invalid fixture release metadata");
  }
  const prefix = `/cool-eva-${metadata.release}/`;
  const server = createServer((request, response) => {
    const name = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) : "";
    if (!["install.sh", "manifest.txt", "bundle.tar.zst"].includes(name)) {
      response.writeHead(404).end();
      return;
    }
    const path = join(directory, name);
    void stat(path)
      .then(details => {
        response.writeHead(200, { "Content-Length": details.size });
        const source = createReadStream(path);
        source.once("error", error => {
          console.error("Fixture asset read failed", error);
          response.destroy(error);
        });
        source.pipe(response);
      })
      .catch(error => {
        console.error("Fixture asset missing", error);
        response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: serverPort(server),
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture TCP port is unavailable");
  }
  return address.port;
}
