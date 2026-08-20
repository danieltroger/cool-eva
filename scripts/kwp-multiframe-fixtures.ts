// Fixtures for scripts/check-kwp-multiframe.ts. Data only — nothing here talks
// to a bus.
//
// ── ⚠️ HOW MUCH OF EACH ONE IS REAL. READ THIS BEFORE TRUSTING A PASS. ─────
// ⚠️ The paragraph that stood here said this channel "has almost no captured payloads",
// because a 2026-08-08 CENSUS of the passive capture had kept service bytes and thrown the
// payloads away. The capture itself kept everything — see docs/vcu-parameters.md §10 — so
// the grades below now say "captured" where they used to say "constructed":
//
//   §A  RECONSTRUCTED FROM TWO INDEPENDENT LIVE RECORDS, then corrected against the
//       capture's sequence numbering. See `BANK2_IDENTIFIER_0001_FRAMES`.
//   §B  CAPTURED VERBATIM — the whole `0x35` request, the `0x36` request, the `0x37`
//       request, and the `75` grant.
//   §C  CAPTURED VERBATIM, and it agrees byte for byte with the decompiled note that was
//       all this had before — the `0x18` request.
//   §D  CONSTRUCTED. The replies, including every `0x36` block body. These prove the
//       transport is self-consistent and rejects what it should. They prove nothing about
//       the bike. ⚠️ Real `0x36` block bodies ARE in the capture now, 1198 of them; see
//       docs/vcu-parameters.md §11 for why replacing these is its own piece of work.
//
// The malformed frames in §D are the ones actually worth having regardless of
// provenance: a transport that completes a transfer from a short Consecutive
// Frame produces a plausible wrong answer, and that is a property of OUR code,
// which these fixtures do exercise honestly.

/**
 * §A — the one multi-frame reply on this channel with real bytes behind it.
 *
 * ✅ Both halves are quoted verbatim off the bike, from two DIFFERENT sessions and two
 * different tools: the First Frame from this project's own live probing on 2026-08-08,
 * the 4-byte record it carries from a bank-2 scan of 2026-07-26. 🔗 They agree — the
 * record's first two bytes are exactly the First Frame's last two — which leaves only
 * one Consecutive Frame it can have been. That single frame is the inferred part, and
 * it is inferred from two independent live records that had to agree and did.
 * docs/diagnostics-and-checks.md §11.3 shows the arithmetic.
 *
 * ⚠️ Its SEQUENCE NUMBER was inferred wrongly and read `F1 21` until 2026-08-20: these
 * micros number the first Consecutive Frame 0 (docs/vcu-parameters.md §10). The bytes were
 * never in doubt; the PCI was.
 *
 * ⚠️ What it does NOT establish: THE ZERO PADDING. Both DLC modes exist on this bus and
 * the length byte governs either way — the reassembler takes 2 bytes here because the
 * First Frame said 7, not because the frame is 8 long.
 */
export const BANK2_IDENTIFIER_0001_FRAMES = ["F1 10 07 62 20 01 00 09", "F1 20 3C B6 00 00 00 00"];

/** What §A must reassemble to: `62` + identifier `2001` + the 4-byte record. */
export const BANK2_IDENTIFIER_0001_PAYLOAD = "62 20 01 00 09 3C B6";

/** The record inside it, as CAN_MAP.md's 2026-07-26 scan recorded it. */
export const BANK2_IDENTIFIER_0001_RECORD = "00 09 3C B6";

/**
 * §B — the whole `0x35` RequestUpload request, captured verbatim at 19:04:32, all three
 * frames of it. This repo's segmenter must produce them byte for byte, which is the
 * strongest assertion in the check and the one that pins BOTH the ten-`0xFF` operand and
 * the 0-based Consecutive Frame numbering.
 *
 * 5 + 6 + 1 = 12 = the `0x00C` the First Frame declares.
 */
export const REQUEST_UPLOAD_FIRST_FRAME = "A8 10 0C 35 12 FF FF FF";
export const REQUEST_UPLOAD_FRAMES = [REQUEST_UPLOAD_FIRST_FRAME, "A8 20 FF FF FF FF FF FF", "A8 21 FF 00 00 00 00 00"];

/** The micro's own flow control between them — the only one ever captured on this channel. */
export const REQUEST_UPLOAD_FLOW_CONTROL_FROM_MICRO = "F1 30 FF 00 00 00 00 00";

/**
 * §B — `0x36` TransferData, captured verbatim and 1198 times over.
 *
 * Every request in the 2026-08-08 transfer is this frame: `A8 02 36 12`, a Single Frame
 * declaring TWO payload bytes. The operand never varies across the 1198, which is what
 * rules out a block-sequence counter — and it is not empty either, which is what this repo
 * assumed until 2026-08-20.
 */
export const TRANSFER_DATA_FRAME = "A8 02 36 12 00 00 00 00";

/**
 * §B — `0x37` RequestTransferExit, captured verbatim: `A8 01 37` at 19:11:49.670991,
 * answered `F1 02 77 FF`. A bare `37`; there is no `37 FF` to fall back to.
 *
 * ⚠️ Zero-padded here where the tool sent a 3-byte DLC. Both DLC modes appear in the same
 * session — 3050 of the tool's own `A8 01 3E` are padded to 8 and 31 are not — and the
 * length byte governs, so the padding is not what this fixture asserts.
 */
export const REQUEST_TRANSFER_EXIT_FRAME = "A8 01 37 00 00 00 00 00";

/** §C — `7C0: A8 04 18 02 FF FF 00 00`, captured on A8 at 19:03:59 and answered `58`. */
export const LIST_STORED_DTCS_FRAME = "A8 04 18 02 FF FF 00 00";

/**
 * §D — a constructed `0x18` reply: two components with codes, then padding.
 *
 * Layout per the service tool's decoder — `58 <count>` then 3-byte `<hi> <lo> <status>`
 * records. The `(0, 0)` third record is the padding that tool filters out and this
 * repo counts instead, so that "the micro padded" stays distinguishable from
 * "component 0 has a fault".
 */
export const STORED_DTC_LIST_FRAMES = ["F1 10 0B 58 03 00 2C 05", "F1 20 00 04 2D 00 00 00"];

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

/**
 * §B — the `75` grant body, captured as `F1 03 75 12 E9`.
 *
 * `E9` = 233 is a maxNumberOfBlockLength, settled rather than guessed: the longest of the
 * 1198 `76` replies that followed is exactly 233 bytes, and none is longer.
 */
export const UPLOAD_GRANT_BODY = "12 E9";
/** The longest `0x36` reply in the captured transfer, and what `E9` turns out to mean. */
export const UPLOAD_MAX_BLOCK_PAYLOAD_BYTES = 233;

/**
 * §D — one block of the largest size the grant allows: `76` plus 232 body bytes.
 *
 * ⚠️ The CONTENT is filler and means nothing; the LENGTH is the assertion. It is here
 * because `TRANSFER_BLOCK_MAX_PAYLOAD_BYTES` was 128 until 2026-08-20 — under the 206…233
 * every real block turns out to be — so the reassembler abandoned block 1 and the read
 * collected nothing. Every other block fixture here is 9…12 bytes and sailed past that.
 */
export const UPLOAD_MAX_LENGTH_BLOCK_BODY = Array.from({ length: UPLOAD_MAX_BLOCK_PAYLOAD_BYTES - 1 }, (_, index) =>
  (index & 0xff).toString(16).padStart(2, "0").toUpperCase()
).join(" ");

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
    frames: ["F1 10 0D 62 20 01 00 09", "F1 21 3C B6 00 00 00 00"],
    refusal: "abandoned",
    because: "sequence 1 arrived where 0 was expected, so bytes are missing",
  },
  {
    // THE one that matters. A Consecutive Frame with a short DLC in the MIDDLE of
    // a transfer: the sequence numbers still run 0, 1, 2…, so nothing looks wrong,
    // and a transport that takes what arrived writes every later byte at the wrong
    // offset and completes at the declared length. A review caught exactly this in
    // the freeze-frame decoder — it produced an int16 with °C on it and an empty
    // `trailingHex`, indistinguishable from a good read.
    name: "short consecutive frame mid-transfer",
    frames: ["F1 10 0D 62 20 01 00 09", "F1 20 3C B6", "F1 21 00 00 00 00 00 00"],
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
    frames: ["F1 20 3C B6 00 00 00 00"],
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
export const SHORT_FINAL_FRAME_TRANSFER = ["F1 10 0D 62 20 01 00 09", "F1 20 3C B6 11 22 33 44", "F1 21 55 66"];
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
