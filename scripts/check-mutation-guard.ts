import assert from "assert/strict";
import { createServer } from "http";
import { once } from "events";
import { handleMutationGuard } from "../src/http/mutation-guard.ts";

let effects = 0;
const server = createServer((request, response) => {
  if (handleMutationGuard(request, response, new URL(request.url!, "http://localhost").pathname)) return;
  effects += 1;
  response.writeHead(200);
  response.end("effect");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
try {
  const rejectedHeaders: Record<string, string>[] = [
    {},
    { "Content-Type": "application/json" },
    { "X-Cool-Eva": "service-mode" },
  ];
  for (const headers of rejectedHeaders) {
    const response = await fetch(base + "/service-action", { method: "POST", headers });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Reload the page/);
    assert.equal(effects, 0, "Either missing barrier must refuse before a side effect.");
  }
  const siri = await fetch(base + "/waypoint");
  assert.equal(siri.status, 200);
  assert.match(await siri.text(), /shortcut needs updating.*No waypoint was saved/);
  const cached = await fetch(base + "/waypoint", { headers: { Accept: "application/json" } });
  assert.equal(cached.status, 200);
  const cachedReply = (await cached.json()) as { saved: boolean; message: string };
  assert.equal(cachedReply.saved, false);
  assert.match(cachedReply.message, /Reload the page/);
  assert.equal(effects, 0);
  const allowed = await fetch(base + "/waypoint", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cool-Eva": "waypoint" },
    body: "{}",
  });
  assert.equal(allowed.status, 200);
  assert.equal(effects, 1);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}
console.log(
  "mutation guard: HTTP barrier covers both missing-header cases; old Siri and cached-page GETs speak recovery and save nothing"
);
