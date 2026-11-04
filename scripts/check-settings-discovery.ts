import assert from "assert/strict";
import { scanHubCandidates, type HubScanner } from "../src/settings/hub-discovery.ts";

let opened = 0;
let started = 0;
let stopped = 0;
let destroyed = 0;
const addresses = ["02:00:00:00:00:01", "02:00:00:00:00:02", "02:00:00:00:00:03"];
const scanner: HubScanner = {
  adapter: async () => ({
    isDiscovering: async () => false,
    startDiscovery: async () => {
      started += 1;
    },
    stopDiscovery: async () => {
      stopped += 1;
    },
    devices: async () => addresses,
    getDevice: async address => ({
      getName: async () => (address.endsWith("01") ? "Synthetic Energica" : "Synthetic unrelated device"),
    }),
  }),
  destroy: () => {
    destroyed += 1;
  },
};
const options = {
  open: () => {
    opened += 1;
    return scanner;
  },
  scanDelayMs: 0,
  timeoutMs: 50,
  stopTimeoutMs: 10,
};
await assert.rejects(
  scanHubCandidates(() => true, options),
  /connection is busy/
);
assert.equal(opened, 0);
await assert.rejects(
  scanHubCandidates(() => false, {
    ...options,
    open: () => {
      throw new Error("Synthetic D-Bus failure");
    },
  }),
  /discovery is unavailable/
);
const candidates = await scanHubCandidates(() => false, options);
assert.deepEqual(candidates, [{ address: addresses[0], name: "Synthetic Energica" }]);
assert.equal(started, 1);
assert.equal(stopped, 1);
assert.equal(destroyed, 1);
const shared: HubScanner = {
  ...scanner,
  adapter: async () => ({ ...(await scanner.adapter()), isDiscovering: async () => true }),
};
await scanHubCandidates(() => false, { ...options, open: () => shared });
assert.equal(started, 1);
assert.equal(stopped, 1);
assert.equal(destroyed, 2);
const stuck: HubScanner = { ...scanner, adapter: () => new Promise(() => {}) };
const first = scanHubCandidates(() => false, { ...options, open: () => stuck, timeoutMs: 10 });
await assert.rejects(
  scanHubCandidates(() => false, options),
  /connection is busy/
);
await assert.rejects(first, /discovery is unavailable/);
assert.equal(destroyed, 3);
await scanHubCandidates(() => false, options);
assert.equal(started, 2);
assert.equal(stopped, 2);
console.log(
  "settings discovery checks passed: bounded read-only candidate scan, handshake/single-flight refusal, own-discovery cleanup and no enrolment/security-counter API"
);
