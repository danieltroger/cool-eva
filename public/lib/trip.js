// @ts-check

import { peek } from "./store.js";
import { monotonicNow, since } from "./clock.js";

// Trip accounting for the current session.
//
// "Session" means since this page was opened, not since the bike was switched on —
// the Pi keeps no readable history, so there is nothing else it could mean. The
// odometer is used as the distance source rather than integrating GPS speed,
// because it is the bike's own measurement and does not drift while stopped.

/** Above this the bike counts as moving, ignoring GPS jitter at a standstill. */
const MOVING_THRESHOLD_KMH = 3;

const startedAt = monotonicNow();
let odometerAtStart = /** @type {number | null} */ (null);
let movingSeconds = 0;
let topSpeedKmh = 0;
let lastUpdateMs = 0;

/**
 * Advance the trip counters. Driven from the same tick as everything else.
 * @param {number} nowMs
 */
export function updateTrip(nowMs) {
  const elapsedS = lastUpdateMs === 0 ? 0 : (nowMs - lastUpdateMs) / 1000;
  lastUpdateMs = nowMs;

  // CAN odometer first, hub second — see the note in derive.js rollingConsumption.
  const odometer = peek("odometer_can_km") ?? peek("odometer_km");
  if (odometer != null && odometerAtStart == null) {
    odometerAtStart = odometer;
  }

  const speed = peek("gps_speed_kmh") ?? peek("speed_can_kmh") ?? peek("speed_kmh");
  if (speed == null) {
    return;
  }
  if (speed > topSpeedKmh) {
    topSpeedKmh = speed;
  }
  if (speed >= MOVING_THRESHOLD_KMH) {
    // Same guard as the dwell timer: a backgrounded tab must not credit its whole
    // absence as riding time.
    movingSeconds += Math.min(elapsedS, 2);
  }
}

/** Kilometres since the page was opened, or null before the odometer arrives. */
export function distanceKm() {
  const odometer = peek("odometer_can_km") ?? peek("odometer_km");
  if (odometer == null || odometerAtStart == null) {
    return null;
  }
  return odometer - odometerAtStart;
}

export function movingTimeSeconds() {
  return movingSeconds;
}

export function elapsedSeconds() {
  return since(startedAt) / 1000;
}

export function topSpeed() {
  return topSpeedKmh;
}

/** Average over moving time only — stops would otherwise drag it to nothing. */
export function averageMovingSpeedKmh() {
  const distance = distanceKm();
  if (distance == null || movingSeconds < 10) {
    return null;
  }
  return distance / (movingSeconds / 3600);
}
