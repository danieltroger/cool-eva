import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRig, within, settle } from "./ble-check-rig.ts";

export async function checkNotificationSizes(mtu: number): Promise<void> {
  const rig = await createRig({ mtu });
  try {
    const connection = rig.client.chooseAndConnect();
    void connection.catch(error => console.log(`check: framed connection ended: ${(error as Error).message}`));
    await settle();
    const bound = mtu === 23 ? 18 : mtu === 185 ? 180 : 512;
    assert.ok(
      rig.frames.every(frame => frame.length <= bound),
      `MTU ${mtu} exceeded multiple-notification value bound`
    );
    await within(connection, `MTU ${mtu} handshake`);
    const response = await within(
      rig.client.tunnelRequest("/bytes", { method: "POST", body: randomBytes(800).toString("hex") }),
      "framed response"
    );
    assert.equal(response.status, 201);
    assert.ok(
      rig.frames.every(frame => frame.length <= bound),
      `MTU ${mtu} response was oversized`
    );
    assert.equal(rig.writes[0][0], 3, "HELLO was not one complete application frame");
  } finally {
    await rig.close();
  }
}
