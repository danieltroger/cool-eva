import { MAX_COMPONENT, MIN_COMPONENT } from "../diagnostics/freeze-frame.ts";
import type { VcuStoredDtcList } from "./multiframe-codec.ts";

// Which components of a `0x18` stored-DTC list may be asked about, and what was dropped.
//
// ⚠️ ITS OWN MODULE, AND PURE, because getting it wrong is expensive in a way the read
// cannot see. `encodeRequestPayload` THROWS on a component outside 1…63, that throw rejects
// the whole read, and ../vcu/read-runner.ts turns it into one error string — so a single
// garbled record would discard every component already read. Dropping happens here, before
// anything is asked, and everything dropped is counted.

/** What the `0x18` list held, and what this read did with it. */
export interface FreezeFrameListReport {
  /** Byte 0 of the body: how many records the micro said follow. */
  declaredCount: number;
  /** Whole records actually parsed. */
  parsed: number;
  /** `(0, 0)` records — the service tool's padding, and not a component. */
  padding: number;
  /**
   * Records naming something outside 1…63.
   *
   * ⚠️ COUNTED SEPARATELY FROM PADDING even though `(0, 0)` is also outside the range,
   * because the two mean opposite things. Padding is the micro filling a frame and is
   * normal; a `(0, 5)` or a `(64, …)` is a list this code cannot read, and a store that
   * treated "everything was dropped" as "the bike has nothing" would turn a transport
   * fault into a confident claim about the motorcycle. ../vcu/freeze-frame-store.ts.
   */
  outOfRange: number;
  /** Components named more than once. `0x17` carries no symptom, so a repeat re-reads one record. */
  duplicate: number;
  /** The micro declared more records than it sent. The list itself is short. */
  truncated: boolean;
  /** Bytes after the last whole record. Empty when the 3-byte record layout fits. */
  trailingHex: string;
}

/**
 * Which components of a `0x18` list may be asked about, and what was dropped.
 *
 * ⚠️ PURE, AND SEPARATE FROM THE READ, because getting it wrong is expensive in a way the
 * read cannot see: `encodeRequestPayload` THROWS on a component outside 1…63, that throw
 * rejects the whole read, and ../vcu/read-runner.ts turns it into one error string — so a
 * single garbled record would discard every component already read. Dropping happens here,
 * before anything is asked, and everything dropped is counted.
 *
 * ⚠️ Deduped for a second reason: `0x17` takes no symptom, so a component named twice
 * returns the same record twice — two store entries for one component and a component's
 * worth of budget spent on nothing.
 */
export function selectComponentsToRead(list: VcuStoredDtcList): {
  components: number[];
  report: FreezeFrameListReport;
} {
  const components: number[] = [];
  const seen = new Set<number>();
  let outOfRange = 0;
  let duplicate = 0;
  for (const record of list.records) {
    // Padding first, so `(0, 0)` is counted as what it is rather than as an illegal
    // component — which it also is. The store's "was this list empty or garbled?" rule
    // reads the two counters apart, and conflating them would make a padded reply
    // indistinguishable from a list this code could not read.
    if (record.code === 0 && record.status === 0) {
      continue;
    }
    if (record.code < MIN_COMPONENT || record.code > MAX_COMPONENT) {
      outOfRange += 1;
      continue;
    }
    if (seen.has(record.code)) {
      duplicate += 1;
      continue;
    }
    seen.add(record.code);
    components.push(record.code);
  }
  return {
    components,
    report: {
      declaredCount: list.declaredCount,
      parsed: list.records.length,
      // ⚠️ The DECODER's count, not a second one walked here. `decodeStoredDtcList` already
      // returns `paddingRecords` over the same `(0, 0)` test, and two definitions of
      // "padding" is how the two stop agreeing.
      padding: list.paddingRecords,
      outOfRange,
      duplicate,
      truncated: list.truncated,
      trailingHex: list.trailingHex,
    },
  };
}

/**
 * What is wrong with a list, or null when nothing is.
 *
 * ⚠️ ONE definition of "damaged", returning the sentence and the verdict together. As two
 * functions over the same three fields they had to agree, and adding a tell to one and not
 * the other would have diverged silently — on the rule that decides whether a good reading
 * is kept.
 *
 * The three tells all mean the same thing: some of the list did not reach this process.
 * `trailingHex` is bytes after the last whole record — one dropped byte at the front shifts
 * everything and leaves fifteen bytes of real records sitting there while `declaredCount`
 * reads 0 and `truncated` is FALSE, because `0 < 0`. `truncated` is fewer whole records than
 * the micro declared. `outOfRange` is a record naming something that is not a component.
 *
 * ⚠️ `duplicate` is NOT one of them. A component named twice is a list this code reads
 * perfectly well; it says nothing about bytes having gone missing, and a repeated component
 * is still a component the bike listed.
 */
export function describeListDamage(list: FreezeFrameListReport): string | null {
  const damage = [
    list.trailingHex === "" ? null : `${list.trailingHex.split(" ").length} byte(s) after the last whole record`,
    list.truncated ? `declared ${list.declaredCount} records and sent ${list.parsed}` : null,
    list.outOfRange === 0 ? null : `${list.outOfRange} record(s) outside 1…63`,
  ].filter(Boolean);
  return damage.length === 0 ? null : damage.join(", ");
}

/** Whether the `0x18` reply can be believed about which components the bike HAS. */
export function listParsedCleanly(list: FreezeFrameListReport): boolean {
  return describeListDamage(list) === null;
}
