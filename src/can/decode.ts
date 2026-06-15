// Pure per-frame decoders for the Energica broadcast frames we log.
// Byte layouts come from obd-garage/CAN_MAP.md. Each decoder returns the list of
// (signal key, value) pairs carried by that frame; unknown IDs return [].
//
// BE = big-endian pair, LE = little-endian pair. Battery temps are signed (can go
// below 0 °C); pack current is signed (charge vs discharge).

export interface DecodedValue {
  key: string;
  value: number;
}

const signedByte = (byte: number): number => (byte > 127 ? byte - 256 : byte);
const u16be = (hi: number, lo: number): number => (hi << 8) | lo;
const i16be = (hi: number, lo: number): number => {
  const value = (hi << 8) | lo;
  return value > 32767 ? value - 65536 : value;
};
const u16le = (lo: number, hi: number): number => (hi << 8) | lo;

export function decodeFrame(id: number, data: Buffer): DecodedValue[] {
  switch (id) {
    // 0x200 — BMS: temps, SOC/SOH, pack V/I (20 Hz). ✅
    case 0x200: {
      if (data.length < 8) return [];
      const packVolts = u16be(data[4], data[5]) / 10;
      const packAmps = i16be(data[6], data[7]) / 10; // signed
      return [
        { key: "batt_temp_lo", value: signedByte(data[0]) },
        { key: "soc", value: data[1] },
        { key: "soh", value: data[2] },
        { key: "batt_temp_hi", value: signedByte(data[3]) },
        { key: "pack_v", value: packVolts },
        { key: "pack_a", value: packAmps },
        { key: "pack_kw", value: Math.round(((packVolts * packAmps) / 1000) * 1000) / 1000 },
      ];
    }

    // 0x201 — charge state: 1 IDLE / 2 AC / 10·16 DC (10 Hz). ✅
    case 0x201: {
      if (data.length < 1) return [];
      return [{ key: "charge_state", value: data[0] }];
    }

    // 0x203 — cell balance: indices + min/max cell mV (20 Hz). ✅
    case 0x203: {
      if (data.length < 8) return [];
      const minCellMv = u16be(data[4], data[5]);
      const maxCellMv = u16be(data[6], data[7]);
      return [
        { key: "cell_avg_mv", value: u16be(data[0], data[1]) }, // 🟡 ≈ avg cell mV
        { key: "cell_min_mv", value: minCellMv },
        { key: "cell_max_mv", value: maxCellMv },
        { key: "cell_spread_mv", value: maxCellMv - minCellMv },
        { key: "max_cell_idx", value: data[2] },
        { key: "min_cell_idx", value: data[3] },
      ];
    }

    // 0x204 — residual/available energy: b0-1 BE ≈ Wh (RES.ENERGY). ❓ unverified
    case 0x204: {
      if (data.length < 2) return [];
      return [{ key: "residual_energy_wh", value: u16be(data[0], data[1]) }];
    }

    // 0x025 — INST.CONS: b0-1 LE ÷10 = Wh (50 Hz). ✅
    case 0x025: {
      if (data.length < 2) return [];
      return [{ key: "inst_consumption_wh", value: u16le(data[0], data[1]) / 10 }];
    }

    // 0x305 — charger DC (charging only, 5 Hz). 🟡
    case 0x305: {
      if (data.length < 7) return [];
      return [
        { key: "mains_a", value: data[1] / 10 },
        { key: "dc_a", value: u16le(data[3], data[4]) / 10 },
        { key: "dc_v", value: u16le(data[5], data[6]) / 10 },
      ];
    }

    // 0x306 — charger AC: mains voltage (charging only, 5 Hz). 🟡
    case 0x306: {
      if (data.length < 3) return [];
      return [{ key: "mains_v", value: data[2] }];
    }

    // 0x447 — charge limit: b6 ÷10 = max charge current A (charging only). 🟡
    case 0x447: {
      if (data.length < 7) return [];
      return [{ key: "charge_limit_a", value: data[6] / 10 }];
    }

    // 0x109 — throttle position: b0-1 LE ÷10 = % (0 idle … 100). 🟡
    case 0x109: {
      if (data.length < 2) return [];
      return [{ key: "throttle_pct", value: u16le(data[0], data[1]) / 10 }];
    }

    // 0x102 — body/lights (decoded live on the bike). b0 bit6 (0x40) = high beam
    // (bit7 0x80 = low beam). b2 is a lights bitfield: 0x04 L blinker, 0x08 R
    // blinker, 0x10 horn, 0x20 front brake, 0x40 rear brake. ✅
    case 0x102: {
      if (data.length < 3) return [];
      const lights = data[2];
      return [
        { key: "high_beam", value: data[0] & 0x40 ? 1 : 0 },
        { key: "brake", value: lights & 0x60 ? 1 : 0 },
        { key: "blinker_left", value: lights & 0x04 ? 1 : 0 },
        { key: "blinker_right", value: lights & 0x08 ? 1 : 0 },
        { key: "horn", value: lights & 0x10 ? 1 : 0 },
      ];
    }

    default:
      return [];
  }
}

// CAN IDs we decode from the broadcast stream — used to set kernel RX filters.
export const STREAM_IDS = [0x025, 0x102, 0x109, 0x200, 0x201, 0x203, 0x204, 0x305, 0x306, 0x447];
