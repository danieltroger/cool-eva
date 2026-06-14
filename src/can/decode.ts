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

const i8 = (b: number): number => (b > 127 ? b - 256 : b);
const u16be = (hi: number, lo: number): number => (hi << 8) | lo;
const i16be = (hi: number, lo: number): number => {
  const v = (hi << 8) | lo;
  return v > 32767 ? v - 65536 : v;
};
const u16le = (lo: number, hi: number): number => (hi << 8) | lo;

export function decodeFrame(id: number, d: Buffer): DecodedValue[] {
  switch (id) {
    // 0x200 — BMS: temps, SOC/SOH, pack V/I (20 Hz). ✅
    case 0x200: {
      if (d.length < 8) return [];
      const v = u16be(d[4], d[5]) / 10; // pack volts
      const a = i16be(d[6], d[7]) / 10; // pack amps (signed)
      return [
        { key: 'batt_temp_lo', value: i8(d[0]) },
        { key: 'soc', value: d[1] },
        { key: 'soh', value: d[2] },
        { key: 'batt_temp_hi', value: i8(d[3]) },
        { key: 'pack_v', value: v },
        { key: 'pack_a', value: a },
        { key: 'pack_kw', value: Math.round(((v * a) / 1000) * 1000) / 1000 },
      ];
    }

    // 0x201 — charge state: 1 IDLE / 2 AC / 10·16 DC (10 Hz). ✅
    case 0x201: {
      if (d.length < 1) return [];
      return [{ key: 'charge_state', value: d[0] }];
    }

    // 0x203 — cell balance: indices + min/max cell mV (20 Hz). ✅
    case 0x203: {
      if (d.length < 8) return [];
      const min = u16be(d[4], d[5]);
      const max = u16be(d[6], d[7]);
      return [
        { key: 'cell_min_mv', value: min },
        { key: 'cell_max_mv', value: max },
        { key: 'cell_spread_mv', value: max - min },
        { key: 'max_cell_idx', value: d[2] },
        { key: 'min_cell_idx', value: d[3] },
      ];
    }

    // 0x204 — residual/available energy: b0-1 BE ≈ Wh (RES.ENERGY). ❓ unverified
    case 0x204: {
      if (d.length < 2) return [];
      return [{ key: 'residual_energy_wh', value: u16be(d[0], d[1]) }];
    }

    // 0x025 — INST.CONS: b0-1 LE ÷10 = Wh (50 Hz). ✅
    case 0x025: {
      if (d.length < 2) return [];
      return [{ key: 'inst_consumption_wh', value: u16le(d[0], d[1]) / 10 }];
    }

    // 0x305 — charger DC (charging only, 5 Hz). 🟡
    case 0x305: {
      if (d.length < 7) return [];
      return [
        { key: 'mains_a', value: d[1] / 10 },
        { key: 'dc_a', value: u16le(d[3], d[4]) / 10 },
        { key: 'dc_v', value: u16le(d[5], d[6]) / 10 },
      ];
    }

    // 0x306 — charger AC: mains voltage (charging only, 5 Hz). 🟡
    case 0x306: {
      if (d.length < 3) return [];
      return [{ key: 'mains_v', value: d[2] }];
    }

    default:
      return [];
  }
}

// CAN IDs we decode from the broadcast stream — used to set kernel RX filters.
export const STREAM_IDS = [0x025, 0x200, 0x201, 0x203, 0x204, 0x305, 0x306];
