import { createBluetooth } from "node-ble";
import { setTimeout as delay } from "timers/promises";
import type { HubCandidate } from "./view.ts";

export async function scanHubCandidates(
  handshakeBusy: () => boolean,
  options: HubScanOptions = {}
): Promise<HubCandidate[]> {
  if (scanning || handshakeBusy()) {
    throw new Error("The motorcycle connection is busy. Wait for it to finish before scanning.");
  }
  scanning = true;
  let link: HubScanner | undefined;
  const scan: ScanContext = { closed: false, stop: null };
  try {
    link = (options.open ?? openScanner)();
    return await withDeadline(collectCandidates(link, scan, options.scanDelayMs ?? 3_000), options.timeoutMs ?? 7_000);
  } catch (error) {
    console.warn("settings: motorcycle discovery failed", error instanceof Error ? error.name : "unknown error");
    throw new Error("Motorcycle discovery is unavailable. Try again after the connection settles.");
  } finally {
    scan.closed = true;
    try {
      if (scan.stop) {
        await withDeadline(scan.stop(), options.stopTimeoutMs ?? 1_000);
      }
    } catch (error) {
      console.warn(
        "settings: could not stop its discovery scan",
        error instanceof Error ? error.name : "unknown error"
      );
    }
    try {
      link?.destroy();
    } finally {
      scanning = false;
    }
  }
}

interface ScanContext {
  closed: boolean;
  stop: (() => Promise<void>) | null;
}
let scanning = false;

async function collectCandidates(scanner: HubScanner, scan: ScanContext, scanDelayMs: number): Promise<HubCandidate[]> {
  const adapter = await scanner.adapter();
  if (scan.closed) return [];
  const alreadyDiscovering = await adapter.isDiscovering();
  if (scan.closed) return [];
  if (!alreadyDiscovering) {
    scan.stop = () => adapter.stopDiscovery();
    await adapter.startDiscovery();
  }
  await delay(scanDelayMs);
  if (scan.closed) return [];
  const candidates: HubCandidate[] = [];
  for (const address of await adapter.devices()) {
    if (scan.closed) return [];
    try {
      const name = await (await adapter.getDevice(address)).getName();
      if (/energica/i.test(name)) {
        candidates.push({ address, name });
      }
    } catch (error) {
      console.log("settings: a discovery result disappeared", error instanceof Error ? error.name : "unknown error");
    }
  }
  return candidates;
}

async function withDeadline<Result>(work: Promise<Result>, milliseconds: number): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Discovery timed out.")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface HubScanner {
  adapter: () => Promise<{
    isDiscovering: () => Promise<boolean>;
    startDiscovery: () => Promise<void>;
    stopDiscovery: () => Promise<void>;
    devices: () => Promise<string[]>;
    getDevice: (address: string) => Promise<{ getName: () => Promise<string> }>;
  }>;
  destroy: () => void;
}
interface HubScanOptions {
  open?: () => HubScanner;
  scanDelayMs?: number;
  timeoutMs?: number;
  stopTimeoutMs?: number;
}
function openScanner(): HubScanner {
  const link = createBluetooth();
  return { adapter: () => link.bluetooth.defaultAdapter(), destroy: link.destroy };
}
