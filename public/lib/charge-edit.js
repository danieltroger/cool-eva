// @ts-check

/** @param {string|null} draft @param {number|null} reported @param {number} minimum @param {number|null} maximum */
export function chargeEdit(draft, reported, minimum, maximum) {
  const text = draft ?? (reported === null ? "" : String(reported));
  const parsed = /^\d+$/.test(text) ? Number(text) : null;
  const value =
    parsed !== null && maximum !== null && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
      ? parsed
      : null;
  return { text, value, changed: value !== null && value !== reported };
}
