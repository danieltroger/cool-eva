import { bounded, SYSTEM_TIMERS, type DeadlineTimers } from "./dbus-link.ts";

export class Owner {
  device: string | null = null;
  epoch = 0;
  #checking = false;
  #timers: DeadlineTimers;

  constructor(timers: DeadlineTimers = SYSTEM_TIMERS) {
    this.#timers = timers;
  }

  claim(device: string): void {
    this.device = device;
    this.epoch++;
  }

  clear(): void {
    this.device = null;
    this.epoch++;
  }

  /** Called only after proof verification, independently of the owner's RX chain. */
  async connected(read: (device: string) => Promise<boolean>): Promise<boolean | null> {
    if (this.#checking || this.device === null) return null;
    this.#checking = true;
    const device = this.device;
    const epoch = this.epoch;
    try {
      const connected = await bounded(read(device), "owner connection lookup", 3_000, this.#timers);
      return this.epoch === epoch ? connected : null;
    } catch (error) {
      console.warn(`ble-server: owner connection read failed (${device}): ${(error as Error).message}`);
      return this.epoch === epoch ? false : null;
    } finally {
      this.#checking = false;
    }
  }
}
