import assert from "node:assert/strict";
import { retryHeadlessLaunch } from "./headless-launch-retry.ts";

let launchCount = 0;
const readyPage = { ready: true };
const recovered = await retryHeadlessLaunch("synthetic Chrome", async () => {
  launchCount++;
  if (launchCount === 1) {
    throw new Error("synthetic cold-start failure");
  }
  return readyPage;
});
assert.equal(recovered, readyPage, "A failed startup can recover on the next attempt.");
assert.equal(launchCount, 2);

let failedLaunchCount = 0;
const failures = [new Error("first startup failed"), new Error("second startup failed")];
await assert.rejects(
  retryHeadlessLaunch("synthetic Chrome", async () => {
    throw failures[failedLaunchCount++];
  }),
  (error: unknown) =>
    error instanceof AggregateError &&
    error.message.includes("after 2 attempts") &&
    error.errors.length === 2 &&
    error.errors[0] === failures[0] &&
    error.errors[1] === failures[1]
);
assert.equal(failedLaunchCount, 2, "A broken browser fails after one retry and preserves both errors.");
console.log("✓ browser startup retries once, preserves the successful result and fails loudly after two failures");
