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
export const CHARGE_FALLBACK = /** @type {const} */ ([20, 65]);
export const CHARGE_MIN_SPAN_C = 25;

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
  const { outside, reportedLow, reportedHigh } = values;
  const validReports = [reportedLow, reportedHigh].filter(value => chargeAllowance(value) !== null);
  if (outside === null || !Number.isFinite(outside) || chargeCeiling(reportedLow, reportedHigh) === null) {
    return {
      low: Math.min(CHARGE_FALLBACK[0], ...validReports.map(value => value ?? CHARGE_FALLBACK[0])),
      high: CHARGE_FALLBACK[1],
      fixed: true,
    };
  }
  let low = Math.max(-30, Math.min(outside - 10, reportedLow ?? 0, reportedHigh ?? 0));
  let high = Math.min(65, Math.max(reportedLow ?? 0, reportedHigh ?? 0) + 10);
  const hottest = Math.max(reportedLow ?? 0, reportedHigh ?? 0);
  const nearest = [0, ...CHARGE_CAP_INTERSECTIONS, 40, 65].reduce(
    (selected, knee) => (Math.abs(knee - hottest) < Math.abs(selected - hottest) ? knee : selected),
    0
  );
  low = Math.min(low, nearest);
  high = Math.max(high, nearest);
  if (high - low < CHARGE_MIN_SPAN_C) {
    const middle = (low + high) / 2;
    low = Math.max(-30, Math.min(65 - CHARGE_MIN_SPAN_C, middle - CHARGE_MIN_SPAN_C / 2));
    high = low + CHARGE_MIN_SPAN_C;
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
