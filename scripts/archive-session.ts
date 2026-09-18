/**
 * One logged signal as `"<ms>:<value> <ms>:<value> …"`, ms from the session's first charging sample.
 *
 * ⚠️ A STRING, and it is not obfuscation: as an array of objects — or even of tuples — prettier
 * prints one row per line and eighteen sessions of real signal become a 4 000-line file nobody can
 * review. One line per signal keeps the diff readable and the data intact; ./charge-auto-archive.ts
 * parses it into the rule's own sample types once, on load.
 */
export type ArchiveSignal = string;

/** One DC charging session out of the decoded archive. ./extract-archive-sessions.ts writes them. */
export interface ArchiveSession {
  /** Which decoded database and when, in CEST — the name used in every assertion message. */
  name: string;
  /** How long the pack drew more than 25 A from the first `fast_dc_target_a` row, in ms. */
  spanMs: number;
  /** `batt_temp_hi`, whole degrees, entire. The ring the estimator sees. */
  temperature: ArchiveSignal;
  /** `soc`, whole percent, entire. */
  soc: ArchiveSignal;
  /** `fast_dc_target_a` — what the vehicle asked the station for. */
  requested: ArchiveSignal;
  /** `coolant_in`, the loop's cold end, for the closed-loop plant. */
  coolantIn: ArchiveSignal;
  /** `fast_dc_limit_max_a` as last seen before or during the session. */
  ceilingAmps: number;
}
