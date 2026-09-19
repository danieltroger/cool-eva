import type { ChargeSession, Ride, Waypoint } from './server/snapshot';

// The shape `/api/summary` puts on the wire, named rather than written inline.
//
// ⚠️ CLAUDE.md bans an inline object literal for a wire shape for the reason the dashboard's
// `DashboardMessage` exists: an endpoint and its consumer that each describe the payload in
// their own words drift, and nothing fails until something is missing at runtime. This is the
// one declaration both sides import, so a change to it breaks `npm run check` instead.

export interface RideSummary {
	builtAtIso: string;
	buildMs: number;
	rides: Ride[];
	charges: ChargeSession[];
	waypoints: Waypoint[];
}
