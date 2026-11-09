// @ts-check

import { hexWord } from "./format.js";

// Raw stamp provenance and market-dependent odometer units: docs/service-stamp.md.

/** @typedef {import("../../src/vcu/service-actions.ts").ServiceStamp} ServiceStamp */

/** @param {ServiceStamp|null} stamp */
export function formatServiceStampDate(stamp) {
  if (!stamp) return "—";
  if (stamp.implausible || !stamp.dateIso || !Number.isFinite(Date.parse(stamp.dateIso))) return "fault";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(stamp.dateIso)
  );
}

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
