// @ts-check

import { hexWord } from "./format.js";

// The last-service stamp, as evidence rather than as a sentence.
//
// The Pi already phrases the outcome (`describeStamp` in src/vcu/write-runner.ts). What it
// does not send anywhere a person can see is the four raw WORDs A8 answered with, and those
// are the only primary evidence there is — the audit journal keeps the DECODED stamp, so on
// 2026-09-08, the first time anything read these identifiers, the bytes behind the reading
// were recorded nowhere. What was read and what it means: docs/service-stamp.md.

/** @typedef {import("../../src/vcu/service-actions.ts").ServiceStamp} ServiceStamp */

/**
 * The stamp's own bytes, and what they decode to, as lines to render under the outcome.
 *
 * ⚠️ Does NOT repeat `implausible`. The server's sentence already ends with it, and this
 * block sits directly underneath — printing it twice was the first draft.
 *
 * Labelled by field name rather than by identifier: `0x13E8`–`0x13EB` live in
 * SERVICE_STAMP_IDENTIFIERS, a TypeScript module the browser cannot import, and restating
 * them here would be the parallel copy this repo keeps abolishing.
 *
 * @param {ServiceStamp} stamp
 * @returns {string[]}
 */
export function describeStampEvidence(stamp) {
  const words = Object.entries(stamp.raw)
    .map(([field, word]) => `${field} ${hexWord(word)}`)
    .join(" · ");
  return [
    `A8 answered ${words}`,
    `→ ${stamp.dateSeconds} s since 2000-01-01 (${stamp.dateIso ?? "undecodable"}) · odometer ${stamp.odometer}`,
  ];
}
