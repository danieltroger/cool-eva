import { monotonicNow, since } from "./monotonic.ts";
import type { ServiceGateSample, ServiceGateReadings } from "./vcu/service-gate.ts";

export function createOsUpdateGate(
  read: (key: string) => ServiceGateSample,
  busy: () => boolean,
  clock = { now: monotonicNow, since }
): OsUpdateGate {
  let stableSince: number | null = null;
  let lastSample = clock.now();
  let ready = false;
  let closed = false;
  const refresh = (): void => {
    if (closed) return;
    const now = clock.now();
    const readings = Object.fromEntries(OS_POWER_KEYS.map(key => [key, read(key)]));
    if (clock.since(lastSample) > 5_000 || !osUpdatePowerAvailable(readings)) {
      stableSince = null;
    } else {
      stableSince ??= now;
    }
    ready = stableSince !== null && clock.since(stableSince) >= 120_000;
    lastSample = now;
  };
  const timer = setInterval(refresh, 1_000);
  timer.unref();
  return {
    ready: () => {
      refresh();
      return ready && !busy();
    },
    close: () => {
      closed = true;
      clearInterval(timer);
      ready = false;
    },
  };
}

export function osUpdatePowerAvailable(readings: ServiceGateReadings): boolean {
  const speed = value(readings, "speed_can_kmh", 1_000);
  const soc = value(readings, "soc");
  const power = value(readings, "pack_kw");
  const inlet = value(readings, "charge_manager_status");
  if (
    speed !== 0 ||
    soc === null ||
    soc < 0 ||
    soc > 70 ||
    power === null ||
    power < 0.2 ||
    power > 200 ||
    inlet === null ||
    !(inlet & 0x08)
  ) {
    return false;
  }
  const mainsVolts = value(readings, "mains_v", 2_000);
  const mainsAmps = value(readings, "mains_a", 2_000);
  const ac =
    mainsVolts !== null &&
    mainsVolts >= 90 &&
    mainsVolts <= 270 &&
    mainsAmps !== null &&
    mainsAmps >= 0.5 &&
    mainsAmps <= 40;
  const dc = value(readings, "fast_dc_contactor", 1_000) === 1;
  return ac || dc;
}

export interface OsUpdateGate {
  ready: () => boolean;
  close: () => void;
}
export const OS_POWER_KEYS = [
  "speed_can_kmh",
  "soc",
  "pack_kw",
  "charge_manager_status",
  "mains_v",
  "mains_a",
  "fast_dc_contactor",
] as const;

function value(readings: ServiceGateReadings, key: string, maximumAge = 5_000): number | null {
  const sample = readings[key];
  return sample &&
    sample.ageMs !== null &&
    sample.ageMs >= 0 &&
    sample.ageMs <= maximumAge &&
    sample.value !== null &&
    Number.isFinite(sample.value)
    ? sample.value
    : null;
}
