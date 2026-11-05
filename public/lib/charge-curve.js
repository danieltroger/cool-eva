// @ts-check
// Exact observed allowance, cap intersections and temperature framing: docs/charge-dashboard.md.
export const CHARGE_CAP_A = 75;
export const CHARGE_CURVE = /** @type {const} */ ([
  [-30, 0],
  [-10, 2],
  [0, 2],
  [10, 80],
  [25, 120],
  [40, 50],
  [65, 0],
]);
export const CHARGE_CAP_INTERSECTIONS = [(10 * (75 - 2)) / (80 - 2), 25 + ((120 - 75) * 15) / (120 - 50)];
export const CHARGE_FALLBACK = /** @type {const} */ ([-30, 65]);
export const CHARGE_MIN_SPAN_C = 30;
const knees = [-30, -10, 0, ...CHARGE_CAP_INTERSECTIONS, 40, 65];

/** @param {number|null} temperature @returns {number|null} */
export function chargeAllowance(temperature) {
  if (temperature === null || !Number.isFinite(temperature) || temperature < -30 || temperature > 65) return null;
  for (let index = 1; index < CHARGE_CURVE.length; index++) {
    const [lowerTemperature, lowerAmps] = CHARGE_CURVE[index - 1];
    const [upperTemperature, upperAmps] = CHARGE_CURVE[index];
    if (temperature <= upperTemperature) {
      const amps =
        lowerAmps +
        ((temperature - lowerTemperature) * (upperAmps - lowerAmps)) / (upperTemperature - lowerTemperature);
      return Math.min(CHARGE_CAP_A, amps);
    }
  }
  return null;
}

/** @param {number|null} low @param {number|null} high */
export function chargeCeiling(low, high) {
  const lowAmps = chargeAllowance(low);
  const highAmps = chargeAllowance(high);
  return lowAmps === null || highAmps === null ? null : Math.min(lowAmps, highAmps);
}

/** @typedef {{outside:number|null,physicalLow:number|null,physicalHigh:number|null,reportedLow:number|null,reportedHigh:number|null}} ChargeTemperatures */
/** @param {ChargeTemperatures} values @returns {{low:number,high:number,fixed:boolean}} */
export function chargeWindow(values) {
  const { outside, physicalLow, physicalHigh, reportedLow, reportedHigh } = values;
  if (
    [outside, physicalLow, physicalHigh, reportedLow, reportedHigh].some(
      value => value === null || !Number.isFinite(value)
    ) ||
    chargeCeiling(reportedLow, reportedHigh) === null
  ) {
    return { low: CHARGE_FALLBACK[0], high: CHARGE_FALLBACK[1], fixed: true };
  }
  const governing =
    (chargeAllowance(reportedLow) ?? 0) <= (chargeAllowance(reportedHigh) ?? 0)
      ? (reportedLow ?? 0)
      : (reportedHigh ?? 0);
  const nearest = knees.reduce(
    (best, knee) => (Math.abs(knee - governing) < Math.abs(best - governing) ? knee : best),
    knees[0]
  );
  const next = knees.find(knee => knee > Math.max(nearest, governing)) ?? 65;
  let low = Math.min((outside ?? 0) - 10, (physicalHigh ?? 0) + 10, reportedLow ?? 0, reportedHigh ?? 0, nearest);
  let high = Math.max((outside ?? 0) - 10, (physicalHigh ?? 0) + 10, reportedLow ?? 0, reportedHigh ?? 0, next);
  if (high - low < CHARGE_MIN_SPAN_C) {
    const padding = (CHARGE_MIN_SPAN_C - (high - low)) / 2;
    low -= padding;
    high += padding;
  }
  low = Math.max(-30, Math.floor(low / 5) * 5);
  high = Math.min(65, Math.ceil(high / 5) * 5);
  if (high - low < CHARGE_MIN_SPAN_C) {
    if (low === -30) {
      high = low + CHARGE_MIN_SPAN_C;
    } else {
      low = high - CHARGE_MIN_SPAN_C;
    }
  }
  return { low, high, fixed: false };
}

/** @param {{low:number,high:number}} window */
export function chargeCurvePoints(window) {
  return [...new Set([window.low, ...CHARGE_CURVE.map(point => point[0]), ...CHARGE_CAP_INTERSECTIONS, window.high])]
    .filter(temperature => temperature >= window.low && temperature <= window.high)
    .sort((left, right) => left - right)
    .map(temperature => ({ temperature, amps: chargeAllowance(temperature) ?? 0 }));
}
