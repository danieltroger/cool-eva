import assert from "node:assert/strict";
import { destinationForPanel } from "../public/lib/destination.js";

assert.equal(destinationForPanel("battery-cooling"), "bike-information");
console.log("✓ the retired Battery & cooling bookmark resolves to Bike");
