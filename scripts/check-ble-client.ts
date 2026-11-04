import { checkBleKeys } from "./ble-check-keys.ts";
import assert from "node:assert/strict";
import { createConnection } from "../public/lib/connection.js";
import {
  MessageKind,
  PROTOCOL_VERSION,
  Direction,
  clearEnvelope,
  encodeMessage,
  sealEnvelope,
  splitIntoFrames,
  randomNonce,
} from "../public/lib/ble-wire.js";
import { createRig, capturedKey, helloFrame, settle, within, until, KEY, type Rig } from "./ble-check-rig.ts";

export async function checkBleClient(): Promise<void> {
  await checkBleKeys();
  await advisoryRecovery();
  await restartRecovery(false);
  await restartRecovery(true);
  await delayedReadRecovery();
  await slowDownload();
  await requestDeadlines();
  console.log("check-ble-client: all checks passed");
}

function connectionFor(rig: Rig) {
  const messages: string[] = [];
  const reports: string[] = [];
  let hidden = false;
  const policy = createConnection({
    now: rig.clock.now,
    hidden: () => hidden,
    report: status => reports.push(status),
    silence: rig.client.abandonSilentSession,
    open: handlers => {
      const socket = { close: () => stream.close() };
      const stream = rig.client.openStream({
        onOpen: () => handlers.opened(socket),
        onMessage: message => {
          if (handlers.received(socket)) {
            messages.push(message.type);
          }
        },
        onClose: () => handlers.closed(socket),
      });
      return socket;
    },
  });
  return {
    policy,
    messages,
    reports,
    hide: () => {
      hidden = true;
      policy.visibilityChanged();
    },
    show: () => {
      hidden = false;
      policy.visibilityChanged();
    },
  };
}
async function advisoryRecovery(): Promise<void> {
  const rig = await createRig();
  try {
    const connection = connectionFor(rig);
    connection.policy.start();
    rig.hook(frame => {
      if (frame[0] === 3 && frame[2] === 0 && rig.hello) {
        for (const [index, clientNonce] of [undefined, randomNonce(), 5].entries()) {
          const unrelated = clearEnvelope(encodeMessage(MessageKind.REFUSED, { reason: "wrong target", clientNonce }));
          for (const notification of splitIntoFrames(unrelated, 81 + index, 18)) {
            rig.notify(notification);
          }
        }
        const refusal = clearEnvelope(
          encodeMessage(MessageKind.REFUSED, { reason: "synthetic advisory", clientNonce: rig.hello.clientNonce })
        );
        for (const notification of splitIntoFrames(refusal, 91, 18)) {
          rig.notify(notification);
        }
      }
    });
    await assert.rejects(rig.client.chooseAndConnect(), /refused this attempt: synthetic advisory/);
    rig.hook(null);
    await settle();
    assert.equal(rig.stored.get("cool-eva.ble-secret"), KEY);
    await rig.clock.advance(2_001);
    connection.policy.tick();
    await until(() => connection.messages.length > 0, "unchanged-key policy recovery after advisory");
    assert.equal(rig.stored.get("cool-eva.ble-secret"), KEY);
    const answer = rig.client.tunnelRequest("/post-once", { method: "POST", body: "synthetic" });
    const refusal = clearEnvelope(
      encodeMessage(MessageKind.REFUSED, { reason: "no session", clientNonce: rig.hello?.clientNonce })
    );
    for (const frame of splitIntoFrames(refusal, 92, 18)) {
      rig.notify(frame);
    }
    await within(answer, "live POST despite clear refusal");
    assert.equal(rig.calls.filter(path => path === "/post-once").length, 1, "advisory retried a POST");
  } finally {
    await rig.close();
  }
}
async function restartRecovery(stuckWrite: boolean): Promise<void> {
  const rig = await createRig();
  try {
    await within(rig.client.chooseAndConnect(), "restart owner");
    const connection = connectionFor(rig);
    connection.policy.start();
    await until(() => connection.messages.length > 0, "first stream snapshot");
    let requestOutcome = "none";
    if (stuckWrite) {
      rig.stallNextWrite();
    }
    const request = rig.client
      .tunnelRequest(stuckWrite ? "/stuck" : "/held", { method: "POST", body: "synthetic" })
      .then(
        () => {
          requestOutcome = "resolved";
        },
        () => {
          requestOutcome = "rejected";
        }
      );
    if (!stuckWrite) {
      await until(() => rig.calls.includes("/held"), "POST received before restart");
    } else {
      await settle();
    }
    await rig.restart();
    await rig.clock.advance(12_001);
    connection.policy.tick();
    await within(request, "watchdog rejected dead-session request");
    assert.equal(requestOutcome, "rejected");
    await rig.clock.advance(2_001);
    connection.policy.tick();
    await until(
      () => connection.messages.length >= 2,
      stuckWrite ? "fresh chain bypassed stuck write" : "same-link restart reauthenticated"
    );
    assert.equal(rig.calls.filter(path => path === "/held").length, stuckWrite ? 0 : 1, "restart resent a POST");
    rig.releaseWrite();
    await settle();
    assert.equal((await within(rig.client.tunnelRequest("/after-restart"), "request after restart")).status, 201);
    connection.hide();
    connection.show();
    await settle();
    assert.equal(rig.device.gatt?.connected, true, "session recovery disconnected GATT");
  } finally {
    await rig.close();
  }
}
async function delayedReadRecovery(): Promise<void> {
  const rig = await createRig();
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  let release: () => void = () => {
    throw new Error("decrypt gate missing");
  };
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let stall = true;
  let entered = false;
  crypto.subtle.decrypt = (...arguments_: Parameters<SubtleCrypto["decrypt"]>) => {
    if (stall) {
      stall = false;
      entered = true;
      return gate.then(() => original(...arguments_));
    }
    return original(...arguments_);
  };
  try {
    const first = rig.client.chooseAndConnect().catch(error => {
      console.log(`check: old WELCOME abandoned: ${(error as Error).message}`);
    });
    await until(() => entered, "old WELCOME decrypt stalled");
    await rig.restart();
    await rig.clock.advance(12_001);
    assert.equal(rig.client.abandonSilentSession(), true);
    await first;
    await within(rig.client.reconnect(), "fresh chain bypassed old read");
    await rig.clock.advance(12_001);
    release();
    await settle();
    assert.equal(rig.client.abandonSilentSession(), true, "late old WELCOME refreshed new-session liveness");
    await within(rig.client.reconnect(), "fresh session after discarded old WELCOME");
    assert.equal((await within(rig.client.tunnelRequest("/fresh-read"), "new session after late WELCOME")).status, 201);
  } finally {
    release();
    crypto.subtle.decrypt = original;
    await rig.close();
  }
}
async function slowDownload(): Promise<void> {
  const rig = await createRig({ holdNotifications: true });
  try {
    const chosen = rig.client.chooseAndConnect();
    await settle();
    rig.flush();
    await within(chosen, "buffered handshake");
    const connection = connectionFor(rig);
    connection.policy.start();
    await settle();
    rig.flush();
    await settle();
    assert.equal(connection.messages.length, 1);
    const helloCount = rig.writes.filter(frame => frame[0] === 3 && frame[2] === 0).length;
    let done = false;
    let failure: Error | undefined;
    let received: Uint8Array | undefined;
    const download = rig.client.tunnelRequest("/big").then(
      response => {
        received = response.body;
        done = true;
      },
      error => {
        failure = error;
        done = true;
      }
    );
    for (let step = 0; step < 100 && !done; step++) {
      await settle();
      await rig.clock.advance(2_000);
      rig.flush();
      await settle();
      connection.policy.tick();
    }
    await within(download, "download while telemetry is starved");
    assert.equal(failure, undefined, "STREAM-only watchdog killed a progressing download");
    assert.deepEqual(received, new Uint8Array(rig.bigBody));
    assert.ok(rig.clock.now() > 12_000, "download fixture never exercised silence threshold");
    assert.equal(
      rig.writes.filter(frame => frame[0] === 3 && frame[2] === 0).length,
      helloCount,
      "authenticated BODY traffic triggered re-HELLO"
    );
  } finally {
    await rig.close();
  }
}
async function requestDeadlines(): Promise<void> {
  const rig = await createRig();
  try {
    await within(rig.client.chooseAndConnect(), "deadline owner");
    let outcome = "pending";
    const request = rig.client.tunnelRequest("/held", { method: "POST" }).then(
      () => {
        outcome = "resolved";
      },
      error => {
        assert.match((error as Error).message, /outcome unknown/);
        outcome = "rejected";
      }
    );
    await until(() => rig.responses.length === 1, "held request");
    await rig.clock.advance(194_999);
    assert.equal(outcome, "pending");
    const key = await capturedKey(rig);
    const stream = await sealEnvelope(
      key,
      Direction.TO_PHONE,
      100,
      encodeMessage(MessageKind.STREAM, { type: "patch", ts: 0, signals: {} })
    );
    for (const frame of splitIntoFrames(stream, 99, 180)) {
      rig.notify(frame);
    }
    await settle();
    await rig.clock.advance(1);
    await within(request, "missing END settled at request deadline");
    assert.equal(outcome, "rejected", "unrelated STREAM traffic extended request deadline");
    assert.equal(rig.client.pendingRequests(), 0);
    const late = await sealEnvelope(key, Direction.TO_PHONE, 101, encodeMessage(MessageKind.RESPONSE_END, { id: 1 }));
    for (const frame of splitIntoFrames(late, 100, 180)) {
      rig.notify(frame);
    }
    await settle();
    assert.equal(rig.client.pendingRequests(), 0);
    assert.equal(rig.calls.filter(path => path === "/held").length, 1);
  } finally {
    await rig.close();
  }
  const progressing = await createRig();
  try {
    await within(progressing.client.chooseAndConnect(), "progress deadline owner");
    const answer = progressing.client.tunnelRequest("/held");
    await until(() => progressing.responses.length > 0, "progressing response");
    const response = progressing.responses[0];
    response.writeHead(200);
    response.flushHeaders();
    await settle();
    for (let index = 0; index < 3; index++) {
      await progressing.clock.advance(100_000);
      response.write("abc");
      await settle();
    }
    response.end("d");
    assert.equal(new TextDecoder().decode((await within(answer, "long progressing response")).body), "abcabcabcd");
    assert.equal(progressing.client.pendingRequests(), 0);
    assert.equal(progressing.clock.count(), 0, "successful END retained request/handshake timer");
  } finally {
    await progressing.close();
  }
}

await checkBleClient();
