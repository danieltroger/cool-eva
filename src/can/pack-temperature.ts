import {
  CLAMP_FLOOR_C,
  CLAMP_GATE_CLOSED,
  CLAMP_GATE_OPEN,
  LIMP_MODE_TEMP_C,
  OFFSET_CONFIG_MIN_DLC,
} from "./decode-bms.ts";
import type { DecodedValue } from "./frame.ts";
import { monotonicNow, since } from "../monotonic.ts";

// Decides which frame is allowed to write batt_temp_lo / batt_temp_hi.
//
// Those two keys have years of history and must keep meaning the TRUE pack temperature.
// On a stock Energica that is 0x200 b0/b3; once the custom LiBAL config is flashed those
// bytes carry the VCU's lowered view and the truth moves to the long 0x660. This routing
// is the ONLY config-dependent decode in the repo. No single frame announces which config
// is flashed, so it is established from what arrives: a long 0x660 proves the offset config
// and carries the truth itself; two consecutive short ones prove the extended config
// WITHOUT the offset, so 0x200 is true; and no 0x660 at all, while the BMS is demonstrably
// transmitting, means a stock pack.

// ⚠️ Until one of those holds, batt_temp_lo/batt_temp_hi are NOT EMITTED AT ALL. That is
// the rule this module exists to enforce, and it is deliberately asymmetric: a gap in a
// log-on-change series reads as "not known yet", whereas a lowered value under the
// true-temperature key reads as a plunge indistinguishable from a failing sensor — and the
// ride log is SEALED, so it can never be corrected afterwards. There is no such thing as a
// safe fallback here; going quiet IS the fallback.
//
// CUSTOM_BMS_CONFIG says which config to expect, but the frames say what actually arrived
// and THE FRAMES WIN. The flag decides nothing that could corrupt data — only how the one
// case the bus can't answer is read, and which mismatch gets warned about. This is routing,
// not deriving: a measured byte is passed through under its historical key or left alone.
//
// The configs, what each does to those bytes, and why no runtime discriminator is offered:
// docs/can-decode-findings.md § "0x200 / 0x660 — pack temperature, and the clamp".

const PACK_THERMAL_FRAME_ID = 0x660;

// How long to wait for a 0x660 before its absence counts as an answer. 0x660 is 1 Hz,
// so five seconds is five chances to see one.
//
// Measured from the first 0x200 seen — NOT from startup, and NOT from the first frame
// of any id. 0x200 and 0x660 sit in the same BMS TX table, so a 0x200 on the wire is
// the proof that the transmitter is alive and that a configured 0x660 would follow
// within a second. Timing from startup would spend the window while the Pi waits hours
// for a sleeping bike; timing from any frame would spend it on VCU traffic while the
// BMS is still asleep. Both leave the window already expired at the moment the first
// 0x200 lands, which is precisely when it has to be full.
const THERMAL_FRAME_WAIT_MS = 5000;

// How many consecutive short 0x660s it takes before 0x200 is given the true keys. This
// is the only transition that can ever write a wrong value — it is what starts feeding
// bytes to batt_temp_lo/batt_temp_hi (0x200 is 20 Hz with deadband 0), and if the pack is
// really on the offset config those bytes are the 15 °C-shifted view. So it needs
// corroboration, in every state and not just when a long frame has already claimed the
// keys: a lone short 0x660 from some other transmitter on the same id must not be able to
// move the routing on its own.
//
// Promotion the other way needs none — a long 0x660 carries the true values itself, so
// acting on the first one is never wrong, and a reflash into the offset config still
// recovers within a second. Two frames is ~2 s at 1 Hz, well inside
// THERMAL_FRAME_WAIT_MS, so the cost is a second of extra silence. One rough edge, and it
// is cosmetic: a 0x660 starting ~4 s after 0x200 can expire the wait window between the
// two short frames, logging "no 0x660 arrived" just before they settle it. Same routing
// either way — only the wording of a one-shot log is briefly wrong.
const SHORT_THERMAL_FRAMES_TO_TRUST = 2;

// 0x200's two temperature bytes, and the true-temperature key each one feeds when 0x200
// is the frame that owns the truth. Matched on the keys the decoder emitted rather than
// on the frame id, so decode-bms.ts stays the only place that knows which bytes of which
// frame these are.
const VCU_TEMPERATURE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["batt_temp_lo_vcu", "batt_temp_lo"],
  ["batt_temp_hi_vcu", "batt_temp_hi"],
];

// Which frame owns batt_temp_lo/batt_temp_hi right now. "unknown" is a real state with
// a real output, not a placeholder: it means nothing is written under those keys.
type TrueTemperatureSource = "unknown" | "vcu-frame" | "thermal-frame";

let customBmsConfigExpected = false;
let trueTemperatureSource: TrueTemperatureSource = "unknown";
// Monotonic, NOT Date.now(): gps/clock.ts steps the wall clock with `date -u -s` from
// this same frame loop, and on a Pi with no RTC the first step after a cold boot is
// routinely hours or years. A backwards step would leave this difference negative
// forever, so the window would never expire and the true keys would stay unwritten for
// the whole ride; a forwards step would expire it instantly and latch "stock" before
// 0x660 had any of its five chances. See ../monotonic.ts.
let firstVcuTemperatureAtMonotonicMs: number | undefined;
let consecutiveShortThermalFrames = 0;
// Diagnostics only — never consulted by a routing decision.
let anyThermalFrameSeen = false;
let warnedThermalFrameMissing = false;
let warnedThermalFrameUnexpected = false;
let warnedThermalFrameShort = false;
// Last batt_temp_hi_vcu off 0x200, and how many consecutive 0x660s have disagreed with
// it. See noteEchoAgreement — diagnostics only, never consulted by a routing decision.
let lastVcuTemperatureHigh: number | undefined;
let consecutiveEchoMismatches = 0;
let warnedEchoMismatch = false;
// The clamp gate's own self-test. See noteClampGate — also diagnostics only.
let consecutiveNonMaskGates = 0;
let consecutiveOpenGatesInClampBand = 0;
let warnedClampGateNotAMask = false;
let warnedClampGateStuckOpen = false;

/**
 * Takes what a frame decoded to and returns what should actually be recorded, adding
 * batt_temp_lo / batt_temp_hi from 0x200's bytes when — and only when — those bytes are
 * KNOWN to be the true temperature. Stateful: it watches 0x660's length as frames
 * arrive, and emits nothing under those keys while the answer is still open.
 */
export function resolvePackTemperatures(id: number, data: Buffer, decoded: DecodedValue[]): DecodedValue[] {
  if (id === PACK_THERMAL_FRAME_ID) {
    notePackThermalFrame(data.length);
    noteEchoAgreement(decoded);
    noteClampGate(decoded);
    return decoded;
  }
  for (const { key, value } of decoded) {
    if (key === "batt_temp_hi_vcu") lastVcuTemperatureHigh = value;
  }
  const trueTemperatures = collectTrueTemperatureCandidates(decoded);
  if (trueTemperatures.length === 0) return decoded;
  firstVcuTemperatureAtMonotonicMs ??= monotonicNow();
  if (!resolveVcuFrameOwnership(firstVcuTemperatureAtMonotonicMs)) return decoded;
  return [...decoded, ...trueTemperatures];
}

/**
 * Call once at startup with the CUSTOM_BMS_CONFIG flag. Default is stock. Resets
 * detection to "nothing known": the flag never establishes a source by itself, and the
 * wait window starts at the first 0x200, which may be hours later.
 */
export function configurePackTemperature(customBmsConfig: boolean): void {
  customBmsConfigExpected = customBmsConfig;
  trueTemperatureSource = "unknown";
  firstVcuTemperatureAtMonotonicMs = undefined;
  consecutiveShortThermalFrames = 0;
  anyThermalFrameSeen = false;
  warnedThermalFrameMissing = false;
  warnedThermalFrameUnexpected = false;
  warnedThermalFrameShort = false;
  lastVcuTemperatureHigh = undefined;
  consecutiveEchoMismatches = 0;
  warnedEchoMismatch = false;
  consecutiveNonMaskGates = 0;
  consecutiveOpenGatesInClampBand = 0;
  warnedClampGateNotAMask = false;
  warnedClampGateStuckOpen = false;
}

// 0x200's VCU-view values, relabelled with the true-temperature keys they would feed.
// Whether they are actually emitted is the caller's decision.
function collectTrueTemperatureCandidates(decoded: DecodedValue[]): DecodedValue[] {
  const candidates: DecodedValue[] = [];
  for (const { key, value } of decoded) {
    for (const [vcuKey, trueKey] of VCU_TEMPERATURE_KEYS) {
      if (key === vcuKey) {
        candidates.push({ key: trueKey, value });
      }
    }
  }
  return candidates;
}

// 0x660 b7 and 0x200 b3 are the same BMS memory (mem 2075) under every config that has
// ever sent a long 0x660, so they cannot legitimately disagree for long. If they do, the
// .bms config's signal is repointed at the wrong slot — which is silent everywhere else,
// because both values stay individually plausible. CLAUDE.md: a failure that "can't
// happen" is exactly the one that has to be loud.
//
// Persistence is required rather than a bare inequality. 0x200 is 20 Hz and 0x660 is
// 1 Hz, so the two are sampled up to a second apart and differ by 1 whenever the pack
// genuinely crosses a degree. A repointing error instead disagrees on every frame and
// usually by a lot, so a few consecutive mismatches separate the two cleanly.
const ECHO_MISMATCHES_BEFORE_WARNING = 3;

function noteEchoAgreement(decoded: DecodedValue[]): void {
  const echo = decoded.find(({ key }) => key === "batt_temp_hi_vcu_echo")?.value;
  // Absent under short 0x660s and under any config that doesn't send the clamp bytes;
  // that is not a mismatch, and neither is a 0x660 that beat the first 0x200.
  if (echo === undefined || lastVcuTemperatureHigh === undefined) return;
  if (echo === lastVcuTemperatureHigh) {
    consecutiveEchoMismatches = 0;
    return;
  }
  consecutiveEchoMismatches += 1;
  if (consecutiveEchoMismatches < ECHO_MISMATCHES_BEFORE_WARNING || warnedEchoMismatch) return;
  warnedEchoMismatch = true;
  console.warn(
    `bms: *** 0x660 b7 (${echo} °C) and 0x200 b3 (${lastVcuTemperatureHigh} °C) disagree on ` +
      `${consecutiveEchoMismatches} consecutive frames, but they read the same BMS memory. ` +
      "The flashed .bms config almost certainly points one of them at the wrong postprocessor " +
      "slot. batt_temp_hi_vcu is what the VCU acts on, so treat it as the real one and re-check " +
      "the config's CANTX signal addresses."
  );
}

// 0x660 b5 under 15-bounded-clamp is a mask the postprocessor builds by dividing a byte by
// 128 and multiplying by 255, so the only values it can hold are 255 (gate closed, the clamp
// is subtracting) and 0 (gate open, the true temperature is going to the VCU). Anything else
// means the arithmetic is not doing what the config was written against, and — unlike the
// clamp itself — that is invisible from every other signal on the bus, because a wrong mask
// still produces a temperature that looks perfectly reasonable.
//
// Worth checking because b5 is the one byte whose meaning is not settled by the frame
// itself: it carried 14-signbit-clamp's clamp_diff until 2026-08-09 (see the b5-7 comment
// in decode-bms.ts for why no runtime discriminator is attempted).

// The three diagnoses a bad value gives, in the order they are worth suspecting:
//   • not 0 or 255 → the bike is almost certainly still on 14-signbit-clamp, where this byte
//     is (true_hi − 35) wrapped. Cheap to confirm: it will equal batt_temp_hi − 35 exactly.
//   • 254 specifically → the Divide operator rounds instead of truncating. Then the mask
//     drops bit 0 of the amount and the reported temperature is up to 1 °C off — a ±1 °C
//     error is the whole symptom, which is why it needs saying out loud.
//   • 0 while the pack sits in the clamped band → the Divide operator is signed, so the gate
//     never closes and the clamp never applies. Fails safe (the VCU sees the truth, and its
//     55 °C limp protection works), but the derate relief the config exists for is not
//     happening. It uses a band config 14 cannot produce, so this warning means "the gate
//     failed to close" and never "you are on the old config" — the two stay separable.
const CLAMP_GATE_FAULTS_BEFORE_WARNING = 3;

// The gate a rounding Divide would emit throughout the clamped band: 2 × 255 truncated to a
// byte. Worth naming because it is a signature rather than just another wrong number — it
// pins the fault on the operator's rounding, where any other non-mask value points at the
// previous config's byte instead.
const ROUNDING_DIVIDE_GATE = 254;

function noteClampGate(decoded: DecodedValue[]): void {
  const gate = decoded.find(({ key }) => key === "clamp_gate")?.value;
  // Absent under short 0x660s and under any config that doesn't send the clamp bytes.
  if (gate === undefined) return;
  noteClampGateIsAMask(gate);
  const trueTemperatureHigh = decoded.find(({ key }) => key === "batt_temp_hi")?.value;
  if (trueTemperatureHigh !== undefined) {
    noteClampGateRegime(gate, trueTemperatureHigh);
  }
}

// Persistence for the same reason the echo check has it: a single odd frame is a misread on
// the wire, a repeated one is the config. At 1 Hz three frames is three seconds.
function noteClampGateIsAMask(gate: number): void {
  if (gate === CLAMP_GATE_CLOSED || gate === CLAMP_GATE_OPEN) {
    consecutiveNonMaskGates = 0;
    return;
  }
  consecutiveNonMaskGates += 1;
  if (consecutiveNonMaskGates < CLAMP_GATE_FAULTS_BEFORE_WARNING || warnedClampGateNotAMask) return;
  warnedClampGateNotAMask = true;
  console.warn(
    `bms: *** 0x660 b5 read ${gate} on ${consecutiveNonMaskGates} consecutive frames, but under ` +
      `15-bounded-clamp it can only be ${CLAMP_GATE_CLOSED} (clamp active) or ${CLAMP_GATE_OPEN} ` +
      `(true temperature being reported). *** ${diagnoseNonMaskGate(gate)} ` +
      "batt_temp_lo/batt_temp_hi are untouched by this either way — b3/b4 carry the true " +
      "temperatures under both configs."
  );
}

function diagnoseNonMaskGate(gate: number): string {
  if (gate === ROUNDING_DIVIDE_GATE) {
    return (
      "That is what a ROUNDING Divide operator produces where the config assumes a truncating " +
      "one. The mask then drops bit 0 of the amount, so the temperature the VCU is shown is up " +
      "to 1 °C off — check batt_temp_hi_vcu against 35 while the pack is in the clamped band."
    );
  }
  return (
    "Most likely this pack is still on 14-signbit-clamp, where b5 is (true pack temp high − 35): " +
    "compare clamp_gate with batt_temp_hi − 35 to confirm. If that is it, this run's clamp_gate " +
    "rows are that difference rather than a gate, and they are reconstructible from batt_temp_hi."
  );
}

function noteClampGateRegime(gate: number, trueTemperatureHigh: number): void {
  const inClampedBand = trueTemperatureHigh > CLAMP_FLOOR_C && trueTemperatureHigh < LIMP_MODE_TEMP_C;
  if (!inClampedBand || gate !== CLAMP_GATE_OPEN) {
    consecutiveOpenGatesInClampBand = 0;
    return;
  }
  consecutiveOpenGatesInClampBand += 1;
  if (consecutiveOpenGatesInClampBand < CLAMP_GATE_FAULTS_BEFORE_WARNING || warnedClampGateStuckOpen) return;
  warnedClampGateStuckOpen = true;
  console.warn(
    `bms: 0x660 b5 has been ${CLAMP_GATE_OPEN} for ${consecutiveOpenGatesInClampBand} consecutive ` +
      `frames with the pack at a true ${trueTemperatureHigh} °C — above the ${CLAMP_FLOOR_C} °C ` +
      `clamp floor and below the ${LIMP_MODE_TEMP_C} °C limp threshold, so the gate should be ` +
      `${CLAMP_GATE_CLOSED}. It is not closing, so nothing is being subtracted and the VCU is ` +
      "seeing the true temperature. " +
      "This fails SAFE — limp mode and every BMS protection still work — but the DC-charge derate " +
      "relief the config exists for is not happening. Likeliest cause: the postprocessor's Divide " +
      "treats its operand as signed, so (true − 55) never yields a quotient of 1 below 55 °C."
  );
}

function notePackThermalFrame(frameLength: number): void {
  anyThermalFrameSeen = true;
  if (frameLength < OFFSET_CONFIG_MIN_DLC) {
    noteShortThermalFrame();
    return;
  }
  // A long 0x660 is proof of the offset config whatever else has been seen, and it
  // carries the true values itself, so it takes the keys immediately — a reflash into the
  // offset config recovers within a second rather than needing a restart.
  consecutiveShortThermalFrames = 0;
  trueTemperatureSource = "thermal-frame";
  if (customBmsConfigExpected || warnedThermalFrameUnexpected) return;
  // The dangerous direction: the offset IS flashed but we were told it wasn't, so
  // 0x200's bytes are the VCU's lowered view. Normally nothing has been logged from them,
  // because the keys stay unwritten until a frame settles the question — but say so loudly
  // anyway, since the flag is wrong and only the operator can fix it.
  warnedThermalFrameUnexpected = true;
  console.error(
    "bms: *** CUSTOM_BMS_CONFIG is not set, but extended 0x660 frames " +
      `(DLC >= ${OFFSET_CONFIG_MIN_DLC}) are arriving. *** The custom BMS config IS flashed, so ` +
      "0x200's temperature bytes are the VCU's LOWERED view, not the truth. Taking " +
      `batt_temp_lo/batt_temp_hi from 0x660. If 0x200 had already been flowing for ` +
      `${THERMAL_FRAME_WAIT_MS} ms when this frame arrived, the keys were briefly fed from 0x200 ` +
      "and those rows are cold by whatever the live config subtracts — up to 19 °C under the " +
      "bounded clamp, at a true 54 °C. Set CUSTOM_BMS_CONFIG=1 and restart."
  );
}

// The extended config WITHOUT the temperature offset: 0x660 exists, but the bytes
// carrying the true temperature don't, so 0x200 is the truth as on a stock pack. Handing
// 0x200 the keys is the transition that starts writing, so it always waits for
// SHORT_THERMAL_FRAMES_TO_TRUST frames to agree — whether the keys are currently held by
// a long 0x660 or by nothing at all.
function noteShortThermalFrame(): void {
  consecutiveShortThermalFrames++;
  if (consecutiveShortThermalFrames < SHORT_THERMAL_FRAMES_TO_TRUST) return;
  trueTemperatureSource = "vcu-frame";
  if (!customBmsConfigExpected || warnedThermalFrameShort) return;
  warnedThermalFrameShort = true;
  console.warn(
    `bms: CUSTOM_BMS_CONFIG is set, but 0x660 arrives in its short form (DLC < ${OFFSET_CONFIG_MIN_DLC}) ` +
      "— that is the extended config WITHOUT the VCU temperature offset. Taking " +
      "batt_temp_lo/batt_temp_hi from 0x200, which is correct for that config. Unset " +
      "CUSTOM_BMS_CONFIG to silence this."
  );
}

// Decides whether 0x200's temperature bytes are currently KNOWN to be the true pack
// temperature, and commits that decision: the stock case latches the source and logs
// once. Never true on a guess — "not established yet" produces the same answer as
// "0x660 owns them", no row written.
function resolveVcuFrameOwnership(waitStartedAtMonotonicMs: number): boolean {
  if (trueTemperatureSource !== "unknown") return trueTemperatureSource === "vcu-frame";
  if (since(waitStartedAtMonotonicMs) < THERMAL_FRAME_WAIT_MS) return false;
  if (customBmsConfigExpected) {
    // The flag says the offset config is flashed, and the frame that would carry the
    // true temperature has never arrived. 0x200 is NOT a fallback: under that config its
    // bytes are the shifted view, and writing them here is the exact corruption this
    // module exists to prevent. Leave the gap and say why.
    if (warnedThermalFrameMissing) return false;
    warnedThermalFrameMissing = true;
    console.warn(
      `bms: CUSTOM_BMS_CONFIG is set but ${describeMissingThermalFrame()}, ` +
        "so nothing on the bus carries the true pack temperature. " +
        "batt_temp_lo/batt_temp_hi stay UNLOGGED until a 0x660 turns up — under this config 0x200's " +
        "bytes are the VCU's lowered view, not the truth. batt_temp_lo_vcu/batt_temp_hi_vcu " +
        "keep logging throughout. If this pack is in fact stock, unset CUSTOM_BMS_CONFIG and the " +
        "true keys resume from 0x200."
    );
    return false;
  }
  // No 0x660 across five of its own broadcast periods while the BMS is demonstrably
  // transmitting, and the flag says stock — that is as close to proof of a stock pack as
  // the bus can give. 0x200 takes the keys and keeps them.
  trueTemperatureSource = "vcu-frame";
  console.log(
    anyThermalFrameSeen
      ? // A 0x660 exists, so this is NOT a stock pack — don't claim it is. 0x200 still
        // takes the keys, and a long 0x660 turning up later still switches them loudly.
        `bms: ${describeMissingThermalFrame()} — batt_temp_lo/batt_temp_hi now come from 0x200.`
      : `bms: ${describeMissingThermalFrame()} — stock config confirmed, ` +
          "batt_temp_lo/batt_temp_hi now come from 0x200."
  );
  return true;
}

// The window can expire with a short 0x660 already seen but not yet corroborated, so
// neither message may claim none arrived. Wording only — the routing above is the same
// either way, and this must never gate it.
function describeMissingThermalFrame(): string {
  if (anyThermalFrameSeen) {
    return (
      `a 0x660 was seen but not corroborated within ${THERMAL_FRAME_WAIT_MS} ms of the first 0x200 ` +
      `(${SHORT_THERMAL_FRAMES_TO_TRUST} consecutive short frames are needed)`
    );
  }
  return `no 0x660 arrived within ${THERMAL_FRAME_WAIT_MS} ms of the first 0x200`;
}
