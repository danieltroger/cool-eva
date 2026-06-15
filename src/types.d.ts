declare module "max31865" {
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
