import { bounded } from "./dbus-link.ts";

export class Owner {
  device: string | null = null;
  epoch = 0;
  #checking = false;

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
      const connected = await bounded(read(device), "owner connection lookup", 3_000);
      return this.epoch === epoch ? connected : null;
    } catch (error) {
      console.warn(`ble-server: owner connection read failed: ${(error as Error).message}`);
      return this.epoch === epoch ? false : null;
    } finally {
      this.#checking = false;
    }
  }
}
