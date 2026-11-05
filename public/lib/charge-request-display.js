// @ts-check
import { chargeAck } from "./charge-write.js";
import { chargeReply } from "./charge-command-display.js";
import { freshValue, readingStatus, statusWord } from "./reading-status.js";

// Request and verdict share a freshness boundary; docs/charge-controls.md.
export function chargeRequestReply() {
  const status = readingStatus("charge_cmd_a");
  const acknowledgement = chargeAck.val;
  if (status !== "fresh") {
    const word = statusWord(status);
    return { request: word, reply: word, acknowledgement: null };
  }
  if (!acknowledgement) {
    return { request: "—", reply: "—", acknowledgement: null };
  }
  const request = freshValue("charge_cmd_a");
  const reply = chargeReply(acknowledgement.verdict);
  return {
    request: request === null ? "—" : `${request} A`,
    reply: typeof reply === "number" ? `${reply} A` : reply,
    acknowledgement,
  };
}
