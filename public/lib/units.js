// @ts-check

import van from "../vendor/van-1.6.1.js";

// Metric vs imperial is a phone-side display choice, applied at the last moment before
// a number reaches the screen. The bike, the log and the plausibility gate (bounds.js)
// all stay in SI — a rider in the US wants mph on the visor, not a different database.
//
// So nothing upstream of a view calls into here: colours (colors.temperature) and bounds
// keep working in Celsius, and only the value + unit label a tile actually renders is
// converted. Every converter reads `unitSystem.val`, so calling one inside a VanJS
// binding subscribes that binding and the whole page flips the instant the toggle moves.

/** @typedef {"metric" | "imperial"} UnitSystem */

const STORAGE_KEY = "coolEva.units";

// Miles per km. Multiply for lengths and speeds (km → mi, km/h → mph); DIVIDE for
// Wh/km → Wh/mi, since a mile is the longer distance and so costs proportionally more.
const KM_TO_MI = 0.621371;
const M_TO_FT = 3.28084;

/**
 * The live unit system, seeded from localStorage so the choice survives the reload the
 * garage wifi forces on you. A binding that reads `.val` re-renders when it flips.
 */
export const unitSystem = van.state(/** @type {UnitSystem} */ (loadPreference()));

/**
 * Set and persist the unit system. The only writer of `unitSystem`.
 * @param {UnitSystem} system
 * @param {boolean} [persist] False previews an unsaved Settings choice.
 */
export function setUnitSystem(system, persist = true) {
  unitSystem.val = system;
  if (!persist) return;
  try {
    localStorage.setItem(STORAGE_KEY, system);
  } catch (error) {
    // Private-mode Safari throws on any localStorage write; the choice just won't
    // persist past this session, which is a far smaller problem than a dead page.
    console.warn("units: could not persist preference", error);
  }
}

/**
 * Absolute temperature. °C → °F.
 * @param {number} celsius
 */
export function temp(celsius) {
  return unitSystem.val === "imperial" ? celsius * 1.8 + 32 : celsius;
}

/**
 * A temperature *difference* (coolant ΔT, degrees-to-derate) — scaled by 9/5 with no
 * +32 offset, because a 1 °C rise is 1.8 °F, not 33.8.
 * @param {number} celsius
 */
export function tempDelta(celsius) {
  return unitSystem.val === "imperial" ? celsius * 1.8 : celsius;
}

/**
 * Speed. km/h → mph.
 * @param {number} kmh
 */
export function speed(kmh) {
  return unitSystem.val === "imperial" ? kmh * KM_TO_MI : kmh;
}

/**
 * Distance. km → mi.
 * @param {number} km
 */
export function distance(km) {
  return unitSystem.val === "imperial" ? km * KM_TO_MI : km;
}

/**
 * Altitude. m → ft.
 * @param {number} metres
 */
export function altitude(metres) {
  return unitSystem.val === "imperial" ? metres * M_TO_FT : metres;
}

/**
 * Energy per distance. Wh/km → Wh/mi. Multiplies by km-per-mile because it is energy
 * *per* mile: a mile is longer than a km, so it costs more Wh.
 * @param {number} whPerKm
 */
export function efficiency(whPerKm) {
  return unitSystem.val === "imperial" ? whPerKm / KM_TO_MI : whPerKm;
}

export function tempUnit() {
  return unitSystem.val === "imperial" ? "°F" : "°C";
}

export function speedUnit() {
  return unitSystem.val === "imperial" ? "mph" : "km/h";
}

export function distanceUnit() {
  return unitSystem.val === "imperial" ? "mi" : "km";
}

export function altitudeUnit() {
  return unitSystem.val === "imperial" ? "ft" : "m";
}

export function efficiencyUnit() {
  return unitSystem.val === "imperial" ? "Wh/mi" : "Wh/km";
}

/** @returns {UnitSystem} */
function loadPreference() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "imperial" ? "imperial" : "metric";
  } catch (error) {
    console.warn("units: could not read stored preference", error);
    return "metric";
  }
}
