import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { handlePsuHoldEndpoint, type PsuHoldReply } from "../src/http/psu-hold.ts";
import { psuFixture } from "./psu-hold-fixture.ts";

export async function checkPsuHoldHttp(): Promise<void> {
  const fixture = psuFixture();
  const server = createServer((request, response) =>
    handlePsuHoldEndpoint(request, response, new URL(request.url ?? "/", "http://localhost"), fixture.hold)
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const get = await fetch(`${origin}/psu-hold`);
    const state = ((await get.json()) as PsuHoldReply).state;
    assert.equal(state.on, false);
    assert.equal(fixture.channels.length, 0);
    assert.equal(get.headers.get("cache-control"), "no-store");
    const query = new URLSearchParams({
      action: "start",
      confirm: "psu-hold-start",
      revision: String(state.revision),
      instance: state.instance,
    });
    const refusedHeaders: Record<string, string>[] = [
      {},
      { "X-Cool-Eva": "service-mode", "Content-Type": "application/json" },
      { "X-Cool-Eva": "service-write" },
    ];
    for (const headers of refusedHeaders) {
      const response = await fetch(`${origin}/psu-hold?${query}`, { method: "POST", headers });
      assert.equal(response.status, 403);
      const reply = (await response.json()) as PsuHoldReply;
      assert.equal(reply.state.on, false);
      if (!headers["X-Cool-Eva"] || !headers["Content-Type"]) {
        assert.equal(reply.csrfRefusal, true);
        assert.match(reply.message, /Reload the page/);
      }
      assert.equal(fixture.channels.length, 0, "Header/JSON refusal must never reach the CAN factory");
    }
    const headers = { "X-Cool-Eva": "service-write", "Content-Type": "application/json" };
    fixture.state.permitted = false;
    const denied = await fetch(`${origin}/psu-hold?${query}`, { method: "POST", headers });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as PsuHoldReply).state.enabled, false);
    assert.equal(fixture.channels.length, 0);
    fixture.state.permitted = true;
    for (const [field, value] of [
      ["confirm", ""],
      ["action", "guess"],
      ["revision", "-1"],
      ["revision", "1.5"],
      ["revision", "9007199254740992"],
    ]) {
      const invalid = new URLSearchParams(query);
      invalid.set(field, value);
      const response = await fetch(`${origin}/psu-hold?${invalid}`, { method: "POST", headers });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as PsuHoldReply).state.on, false);
      assert.equal(fixture.channels.length, 0);
    }
    const staleBoot = new URLSearchParams(query);
    staleBoot.set("instance", "previous-boot");
    assert.equal((await fetch(`${origin}/psu-hold?${staleBoot}`, { method: "POST", headers })).status, 409);
    assert.equal(fixture.channels.length, 0);
    const started = await fetch(`${origin}/psu-hold?${query}`, { method: "POST", headers });
    assert.equal(started.status, 200);
    const on = ((await started.json()) as PsuHoldReply).state;
    assert(on.on);
    assert.equal(on.remainingMs, 3_600_000);
    assert.equal(fixture.channels[0].frames.length, 1);
    assert.equal((await fetch(`${origin}/psu-hold?${query}`, { method: "POST", headers })).status, 409);
    const extend = new URLSearchParams({
      action: "extend",
      confirm: "psu-hold-extend",
      revision: String(on.revision),
      instance: on.instance,
    });
    fixture.clock.jump(1000);
    const extended = await fetch(`${origin}/psu-hold?${extend}`, { method: "POST", headers });
    assert.equal(extended.status, 200);
    const renewed = ((await extended.json()) as PsuHoldReply).state;
    assert.equal(renewed.remainingMs, 3_600_000);
    assert.equal((await fetch(`${origin}/psu-hold?${extend}`, { method: "POST", headers })).status, 409);
    const stop = new URLSearchParams({
      action: "stop",
      confirm: "psu-hold-stop",
      revision: String(renewed.revision),
      instance: renewed.instance,
    });
    fixture.state.permitted = false;
    const stopped = await fetch(`${origin}/psu-hold?${stop}`, { method: "POST", headers });
    const off = (await stopped.json()) as PsuHoldReply;
    assert.equal(stopped.status, 200);
    assert.equal(off.state.on, false);
    assert.equal(off.state.lastStopReason, "owner");
    assert.equal(fixture.channels[0].stops, 1);
    const wrongMethod = await fetch(`${origin}/psu-hold`, { method: "DELETE", headers });
    assert.equal(wrongMethod.status, 405);
    assert.equal(((await wrongMethod.json()) as PsuHoldReply).state.on, false);
    console.log(
      "psu-hold HTTP: zero-TX negative gates, CSRF reload metadata, permission/header, explicit renew/replay and authoritative replies pass"
    );
  } finally {
    fixture.hold.close();
    server.close();
    await once(server, "close");
  }
}

await checkPsuHoldHttp();
