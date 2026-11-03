import type dbus from "dbus-next";

export async function bounded<Result>(call: Promise<Result>, what: string, timeoutMs = 10_000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what}: bluetoothd did not answer in ${timeoutMs / 1000} s`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
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
