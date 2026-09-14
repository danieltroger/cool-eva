import { NEVER_CAPTURED, UNLABELLED } from "../public/lib/state-labels.js";

// The 0x101 frames scripts/check-vehicle-state-labels.ts runs through the label functions.
//
// Data only, so the check stays assertions: the same split as scripts/captured-pack-frames.ts
// and scripts/charge-ack-fixtures.ts, and what takes that file back under the ~400 lines
// CLAUDE.md asks for.

export interface Probe {
  what: string;
  hex: string;
  tile: "state" | "substate";
  expect: string;
  synthetic?: true;
}

/**
 * Frames through the real decoder and the real label functions.
 *
 * ⚠️ Real bytes wherever a real frame can reach the branch, because a label pinned to a frame
 * the bike sent cannot be argued with. Two branches no capture can ever reach are marked
 * `synthetic` — the convention scripts/check-vehicle-status.ts already uses — and they are the
 * newest code in the file: a pair in NEITHER table is by construction one the bike has never
 * sent, and it is the branch the "never captured" sentinel lives in.
 */
export const BEHAVIOUR: Probe[] = [
  {
    what: "parked",
    hex: "3E 3C 04 04 64 00 00 00",
    tile: "substate",
    expect: "parked",
  },
  {
    what: "🔥 substate 150, bit 7 set — the branch that proves the latching map is consulted AT ALL. 150 is in no band, so a pairs-only lookup calls a documented start-up step uncaptured. ⚠️ It does not pin the ORDER: a pairs-first version falling through here behaves identically, which the mutation suite established by having that reordering survive",
    hex: "96 28 04 04 64 00 00 00",
    tile: "substate",
    expect: "drive-enable step",
  },
  {
    what: '🔥 substate 143, the LOWEST bit-7 value — the boundary. `substate >= 128` widened to `>= 144` leaves every table agreeing and renders this documented drive-enable step as "never captured" in the fault ink; 150 does not catch it. 2026-08-02 21:05:01.386245, capture-20260802-210358-346ecdd5.log',
    hex: "8F 28 04 04 64 00 00 00",
    tile: "substate",
    expect: "drive-enable step",
  },
  {
    what: '🔥 the state tile over a pair that HAS a phrase — pins that the pair wins over the state fallback. Drop stateLabel()\'s early return and this reads "charging", which is what the DC screenshot would have stopped saying',
    hex: "68 64 04 14 4B 00 00 00",
    tile: "state",
    expect: "DC charging",
  },
  {
    what: "riding",
    hex: "2B 28 06 44 72 00 00 00",
    tile: "substate",
    expect: "riding",
  },
  {
    what: "park assist — and ⚠️ NOT a direction: 52 and 53 both read the same phrase",
    hex: "34 28 06 0C 4B 00 00 00",
    tile: "substate",
    expect: "park assist",
  },
  {
    what: "the blocking fault",
    hex: "53 50 04 14 55 00 00 00",
    tile: "substate",
    expect: "blocking fault",
  },
  {
    what: "state 1 / substate 3 — documented, and nobody knows what it is",
    hex: "03 01 04 14 64 00 00 00",
    tile: "substate",
    expect: UNLABELLED,
  },
  {
    what: "the state tile over a state whose own meaning is measured but whose substate's is not",
    hex: "66 64 04 14 64 00 00 00",
    tile: "state",
    expect: "charging",
  },
  {
    what: "SYNTHETIC — a pair in NEITHER table. No capture can carry one by definition, and this is the branch the sentinel lives in",
    hex: "2B 64 04 14 64 00 00 00",
    tile: "substate",
    expect: NEVER_CAPTURED,
    synthetic: true,
  },
  {
    what: "SYNTHETIC — a bit-7 substate that is in no table either",
    hex: "91 64 04 14 64 00 00 00",
    tile: "substate",
    expect: NEVER_CAPTURED,
    synthetic: true,
  },
];
