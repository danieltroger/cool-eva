// Minimal shim for the `socketcan` native module (sebi2k1/node-can). The package
// ships its own types, but it only installs on Linux (it's an optionalDependency),
// so this keeps `tsc` resolving on macOS/CI where the native build is skipped.
// (tsconfig has skipLibCheck, so this coexists with the bundled types on Linux.)
declare module 'socketcan' {
  export interface CanMessage {
    id: number;
    length?: number;
    data: Buffer;
    ext?: boolean;
    rtr?: boolean;
    ts_sec?: number;
    ts_usec?: number;
  }
  export interface RxFilter {
    id: number;
    mask: number;
  }
  export interface RawChannel {
    addListener(event: 'onMessage', cb: (msg: CanMessage) => void): void;
    addListener(event: string, cb: (...args: unknown[]) => void): void;
    send(msg: CanMessage): number;
    start(): RawChannel;
    stop(): RawChannel;
    setRxFilters(filters: RxFilter | RxFilter[]): void;
    disableLoopback(): void;
  }
  export function createRawChannel(channel: string, timestamps?: boolean): RawChannel;
  export function createRawChannelWithOptions(channel: string, options: object): RawChannel;
  const _default: {
    createRawChannel: typeof createRawChannel;
    createRawChannelWithOptions: typeof createRawChannelWithOptions;
  };
  export default _default;
}

declare module 'max31865' {
  interface MAX31865Options {
    rtdNominal?: number;
    refResistor?: number;
    wires?: 2 | 3 | 4;
  }

  export default class MAX31865 {
    constructor(bus?: number, device?: number, options?: MAX31865Options);
    init(): Promise<void>;
    getTemperature(): Promise<number>;
    readRtd(): Promise<number>;
    getResistance(): Promise<number>;
    readU8(address: number): Promise<number>;
    readU16(address: number): Promise<number>;
    writeU8(address: number, byte: number): Promise<void>;
    getFaults(): Promise<object>;
    clearFaults(): Promise<void>;
    getBias(): Promise<boolean>;
    setBias(enable: boolean): Promise<void>;
    getAutoConvert(): Promise<boolean>;
    setAutoConvert(enable: boolean): Promise<void>;
  }
}
