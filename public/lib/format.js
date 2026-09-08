// @ts-check

// Number → string, for a screen read at a glance through a visor.
//
// The rule throughout: never show more precision than you can act on. Coolant gets
// one decimal because 0.1 °C of loop ΔT is real; speed gets none because nobody
// rides to a tenth of a km/h, and a jittering last digit is what makes a dashboard
// tiring to look at.

/**
 * @param {number | null} value
 * @param {number} digits
 * @returns {string}
 */
export function fixed(value, digits) {
  return value == null ? "–" : value.toFixed(digits);
}

/**
 * Whole numbers, with the sign kept for signed quantities like power.
 * @param {number | null} value
 */
export function whole(value) {
  return value == null ? "–" : String(Math.round(value));
}

/**
 * Power in kW: one decimal below 10 so gentle riding is legible, none above,
 * where the tenth is noise and the extra digit costs width.
 * @param {number | null} kilowatts
 */
export function power(kilowatts) {
  if (kilowatts == null) {
    return "–";
  }
  return Math.abs(kilowatts) < 10 ? kilowatts.toFixed(1) : String(Math.round(kilowatts));
}

/**
 * Bytes as the download button's "4.2 MB".
 * @param {number} bytes
 */
export function bytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Elapsed seconds as `1:04:12` / `4:12`.
 * @param {number} totalSeconds
 */
export function duration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const pad = /** @param {number} n */ n => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${minutes}:${pad(remainder)}`;
}

/**
 * How long ago a Pi timestamp was — "just now", "17 min ago", "3 days ago".
 *
 * ⚠️ Computed on the PHONE against the Pi's wall clock, which ../lib/clock.js otherwise
 * forbids. It is deliberate here and the reason is the Pi: it has no RTC and steps its
 * own clock from GPS, so of the two clocks in this pairing the phone's is the one worth
 * trusting. The result is a rough age on a label, never a duration anything depends on,
 * and a Pi that has not had a fix yet will show an absurd one — which is itself the
 * right thing to see.
 *
 * @param {number | null} epochMs
 */
export function ageInWords(epochMs) {
  if (epochMs === null) {
    return "at an unknown time";
  }
  const minutes = Math.round((Date.now() - epochMs) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 90) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * A time of day, in whatever timezone the phone is in.
 *
 * The bike stamps UTC — it has no RTC and steps its own clock from the satellites — and
 * a rider asking when they saved something wants their own clock, so the conversion is
 * the browser's rather than ours. Hours and minutes only: a waypoint's second is not a
 * thing anyone reads off a tile.
 *
 * `hourCycle` is pinned rather than left to the locale, which would render an en-US phone
 * "06:13 PM" — three glyphs wider in a tile measured at 84 px, and the only 12-hour clock
 * anywhere in this dashboard or its Grafana dashboards.
 * @param {number} epochMs
 */
export function clockTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/**
 * Degrees to a compass point. A heading of 237° means nothing at speed; "SW" does.
 * @param {number | null} degrees
 */
export function compass(degrees) {
  if (degrees == null) {
    return "–";
  }
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round(degrees / 45) % 8];
}

/**
 * A number at whatever precision it needs.
 *
 * ⚠️ ONE rule, used by the All tab's grid and by the lifetime block pinned above it.
 * They sit against each other on the same screen, and two numbers a centimetre apart
 * disagreeing about what "precise" means is what you notice first.
 *
 * @param {number} value
 */
export function reading(value) {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2);
}

/**
 * …with its thousands grouped. Only the lifetime block uses this.
 *
 * 658 112 is legible where 658112 is a smear, and that block carries the two longest
 * numbers on the dashboard. The live grid is deliberately left ungrouped: its values
 * change several times a second and a group separator appearing and disappearing under
 * a moving number is worse than the smear.
 *
 * @param {number} value
 */
export function groupedReading(value) {
  const [whole, fraction] = reading(value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
