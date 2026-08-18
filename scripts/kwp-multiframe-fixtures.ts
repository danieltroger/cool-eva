// Fixtures for scripts/check-kwp-multiframe.ts. Data only — nothing here talks
// to a bus.
//
// ── ⚠️ HOW MUCH OF EACH ONE IS REAL. READ THIS BEFORE TRUSTING A PASS. ─────
// This channel has almost no captured payloads. The 2026-08-08 passive capture of
// the factory software counted 26 662 requests and kept only their SERVICE bytes,
// so `0x17`, `0x18`, `0x36` and `0x37` have counts and outcomes behind them and
// no bytes. What follows is graded, and the grades differ sharply:
//
//   §A  RECONSTRUCTED FROM TWO INDEPENDENT LIVE RECORDS. The strongest thing
//       here, and the only multi-frame reply on this channel with any real bytes
//       in it at all. See `BANK2_IDENTIFIER_0001_FRAMES`.
//   §B  CAPTURED VERBATIM, request side only — the `0x35` First Frame.
//   §C  DECOMPILED, not sniffed — the `0x18` request.
//   §D  CONSTRUCTED. Everything else, including every `0x36` block. These prove
//       the transport is self-consistent and rejects what it should. They prove
//       nothing about the bike.
//
// The malformed frames in §D are the ones actually worth having regardless of
// provenance: a transport that completes a transfer from a short Consecutive
// Frame produces a plausible wrong answer, and that is a property of OUR code,
// which these fixtures do exercise honestly.

/**
 * §A — the one multi-frame reply on this channel with real bytes behind it.
 *
 * ✅ The FIRST FRAME is quoted verbatim off the bike. obd-garage/DIAG_ADDRESSES.md
 * §3's responder table records A8 answering `22 2001` (bank 2, live data) with
 * `F1 10 07 62 20 01 00 09`, marked "(multiframe) **no auth**", from this
 * project's own live probing on 2026-08-08.
 *
 * ✅ The PAYLOAD is quoted verbatim off the bike too, from a DIFFERENT session
 * and a different tool. obd-garage/CAN_MAP.md's A8 scan of 2026-07-26 records
 * bank-2 record `0001` = `00093cb6` — one of four multi-byte records that a bug
 * in `kwp_scan.py` had been silently dropping until it was fixed and re-run.
 *
 * 🔗 The two agree, and that is what makes this a real fixture rather than a
 * construction. The First Frame declares 7 payload bytes and carries five of
 * them: `62 20 01 00 09`. The scan says the record is `00 09 3C B6`. The first
 * two bytes of the record are exactly the last two bytes of the First Frame, and
 * `62` + identifier `20 01` + a 4-byte record is exactly 7. So the Consecutive
 * Frame carried `3C B6`, and there is only one frame it can have been:
 *
 *     F1 21 3C B6 00 00 00 00
 *
 * That single frame is the inferred part, and it is inferred from two independent
 * live records that had to agree and did. Everything else here is quotation.
 *
 * ⚠️ What it does NOT establish: the zero padding. Both DLC modes exist on this
 * bus (obd-garage/SERVICE_RESET.md, and DIAG_ADDRESSES.md §9.2 records the same
 * write both padded and not), and the length byte governs either way — the
 * reassembler takes 2 bytes here because the First Frame said 7, not because the
 * frame is 8 long.
 */
export const BANK2_IDENTIFIER_0001_FRAMES = ["F1 10 07 62 20 01 00 09", "F1 21 3C B6 00 00 00 00"];

/** What §A must reassemble to: `62` + identifier `2001` + the 4-byte record. */
export const BANK2_IDENTIFIER_0001_PAYLOAD = "62 20 01 00 09 3C B6";

/** The record inside it, as CAN_MAP.md's 2026-07-26 scan recorded it. */
export const BANK2_IDENTIFIER_0001_RECORD = "00 09 3C B6";

/**
 * §B — the `0x35` RequestUpload First Frame, captured verbatim.
 *
 * obd-garage/DIAG_ADDRESSES.md §9.6, from the 2026-08-08 passive capture of the
 * factory software: `A8 10 0C 35 12 FF FF FF`, declaring `0x00C` = 12 payload
 * bytes and carrying the first five. This repo's segmenter must produce this
 * frame byte for byte, which is the single strongest assertion in the check.
 *
 * ⚠️ The Consecutive Frames that followed it were NOT captured — the census
 * filtered by service byte and a Consecutive Frame has none. So the seven operand
 * bytes they carried are unknown, and the two frames below are what
 * src/vcu/multiframe-codec.ts' guess produces, not what the tool sent.
 */
export const REQUEST_UPLOAD_FIRST_FRAME = "A8 10 0C 35 12 FF FF FF";

/** §C — `7C0: A8 04 18 02 FF FF`, from obd-garage/OTHER_TOOL_AUDIT.md §4.3. Decompiled, not sniffed. */
export const LIST_STORED_DTCS_FRAME = "A8 04 18 02 FF FF 00 00";

/**
 * §D — a constructed `0x18` reply: two components with codes, then padding.
 *
 * Layout per the service tool's decoder — `58 <count>` then 3-byte `<hi> <lo> <status>`
 * records. The `(0, 0)` third record is the padding that tool filters out and this
 * repo counts instead, so that "the micro padded" stays distinguishable from
 * "component 0 has a fault".
 */
export const STORED_DTC_LIST_FRAMES = ["F1 10 0B 58 03 00 2C 05", "F1 21 00 04 2D 00 00 00"];

/** What §D's list must decode to: 3 declared, 3 parsed, one of them padding, nothing left over. */
export const STORED_DTC_LIST_EXPECTED = { declaredCount: 3, codes: [0x2c, 0x04, 0x00], paddingRecords: 1 };

/**
 * §D — a constructed bulk-upload block, in the shape the service tool's
 * `KWP2000Moto.ReadFreezeFrame` implies: a 4-byte big-endian timestamp (seconds
 * since 2000-01-01), then `<compHi> <compLo> <status>`, then a field block.
 *
 * ⚠️ Constructed entirely. No `0x36` payload has ever been seen. This exists to
 * prove the RUNNER collects blocks in order and hands them back unaltered — which
 * is why the transport keeps them undecoded, and why this fixture asserts bytes
 * rather than meaning.
 */
export const UPLOAD_BLOCK_BODIES = [
  "0C A1 B2 C3 00 2C 05 03 00 00 00 02",
  "0C A1 B4 01 00 04 2D 02 00 00 0D 7C",
  "0C A1 B5 42 00 33 11 00 01",
];

/** The `75` grant body, captured as part of `75 12 E9` in DIAG_ADDRESSES.md §9.6. */
export const UPLOAD_GRANT_BODY = "12 E9";

/**
 * §D — the malformed replies the transport must ABANDON rather than complete.
 *
 * Each is the §A transfer with one thing wrong, so the difference between passing
 * and failing is exactly the defect named and nothing else.
 */
export const MALFORMED_TRANSFERS: readonly {
  name: string;
  frames: string[];
  /**
   * `abandoned` means the transport recognised the frames as ours and threw the
   * transfer away. `not-consumed` means it did not recognise them at all, handed
   * them back to the shared socket, and let the window time out. Both are
   * acceptable refusals and they are different behaviours, so the check asserts
   * which one rather than accepting either — otherwise a transport that stopped
   * recognising anything would pass every case here.
   */
  refusal: "abandoned" | "not-consumed";
  because: string;
}[] = [
  {
    name: "gapped consecutive frame",
    frames: ["F1 10 0D 62 20 01 00 09", "F1 22 3C B6 00 00 00 00"],
    refusal: "abandoned",
    because: "sequence 2 arrived where 1 was expected, so bytes are missing",
  },
  {
    // THE one that matters. A Consecutive Frame with a short DLC in the MIDDLE of
    // a transfer: the sequence numbers still run 1, 2, 3…, so nothing looks wrong,
    // and a transport that takes what arrived writes every later byte at the wrong
    // offset and completes at the declared length. A review caught exactly this in
    // the freeze-frame decoder — it produced an int16 with °C on it and an empty
    // `trailingHex`, indistinguishable from a good read.
    name: "short consecutive frame mid-transfer",
    frames: ["F1 10 0D 62 20 01 00 09", "F1 21 3C B6", "F1 22 00 00 00 00 00 00"],
    refusal: "abandoned",
    because: "a mid-transfer consecutive frame carried 2 bytes where 6 were needed",
  },
  {
    name: "first frame over the cap",
    frames: ["F1 1F FF 62 20 01 00 09"],
    refusal: "abandoned",
    because: "declares 4095 bytes, far over any cap this transport allows",
  },
  {
    name: "first frame that would have fitted one frame",
    frames: ["F1 10 04 62 20 01 00 09"],
    refusal: "not-consumed",
    because: "a 4-byte payload is a single frame; honouring it would wait forever for a consecutive frame",
  },
  {
    name: "consecutive frame with no first frame",
    frames: ["F1 21 3C B6 00 00 00 00"],
    refusal: "not-consumed",
    because: "the tail of somebody else's transfer, and it must go back to the shared socket",
  },
];

/**
 * §D — a transfer whose LAST consecutive frame is legitimately short.
 *
 * The counterpart to the case above, and the reason that one cannot simply be
 * "reject every short frame": the final frame of a transfer carries only what is
 * left. This must COMPLETE. 13 declared bytes = 5 in the First Frame, 6 in the
 * first Consecutive Frame, 2 in the last.
 */
export const SHORT_FINAL_FRAME_TRANSFER = ["F1 10 0D 62 20 01 00 09", "F1 21 3C B6 11 22 33 44", "F1 22 55 66"];
export const SHORT_FINAL_FRAME_PAYLOAD = "62 20 01 00 09 3C B6 11 22 33 44 55 66";

/**
 * §D — replies that are well-formed but are somebody ELSE'S answer.
 *
 * These micros answer on ONE CAN id with no request/response tag, so a reply
 * naming another service is not ours and filing it as ours is the silent wrong
 * answer this repo keeps refusing to ship. The refusal is the subtler of the two:
 * `7F 22 31` is a perfectly good negative response and would read as "the freeze
 * frame was refused" if the service byte were not checked.
 */
export const FOREIGN_POSITIVE_FRAME = "F1 05 62 20 01 01 23";
export const FOREIGN_REFUSAL_FRAME = "F1 03 7F 22 31";
/** Addressed to another tester entirely. Must not be consumed at all. */
export const OTHER_TESTER_FRAME = "F2 10 07 62 20 01 00 09";
