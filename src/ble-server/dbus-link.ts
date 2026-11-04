import type dbus from "dbus-next";

export async function bounded<Result>(
  call: Promise<Result>,
  what: string,
  timeoutMs = 10_000,
  timers: DeadlineTimers = SYSTEM_TIMERS
): Promise<Result> {
  let timer: DeadlineTimer | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        timer = timers.setTimer(
          () => reject(new Error(`${what}: bluetoothd did not answer in ${timeoutMs / 1000} s`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      timers.clearTimer(timer);
    }
  }
}

export type DeadlineTimer = ReturnType<typeof setTimeout> | number;
export interface DeadlineTimers {
  setTimer(callback: () => void, milliseconds: number): DeadlineTimer;
  clearTimer(timer: DeadlineTimer): void;
}
export const SYSTEM_TIMERS: DeadlineTimers = {
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: timer => clearTimeout(timer),
};
export interface BusLink {
  getProxyObject(service: string, path: string): Promise<{ getInterface(name: string): unknown }>;
  export(path: string, implementation: InstanceType<typeof dbus.interface.Interface>): void;
  on(event: "message" | "error", listener: (value: unknown) => void): unknown;
  off(event: "message" | "error", listener: (value: unknown) => void): unknown;
  disconnect(): void;
}
export interface PropertiesInterface {
  Get(iface: string, property: string): Promise<{ value: unknown }>;
}
