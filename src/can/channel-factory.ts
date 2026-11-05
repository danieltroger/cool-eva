import type { RawChannel, RawChannelOptions } from "socketcan";

export function createMainCanChannel(factory: CanChannelFactory, iface = "can0"): RawChannel {
  return factory.createRawChannelWithOptions(iface, { timestamps: true, non_block_send: true });
}

export interface CanChannelFactory {
  createRawChannelWithOptions: (iface: string, options: RawChannelOptions) => RawChannel;
}
