// @ts-check
import van from "../vendor/van-1.6.1.js";
import { OwnerActionRow } from "./owner-action.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import { describeStampEvidence } from "../lib/service-stamp.js";
import {
  refreshServiceStatus,
  sendServiceWrite,
  serviceBusy,
  serviceCanAct,
  serviceOperation,
} from "../lib/service-client.js";

export function LastServiceRead() {
  return div(
    { class: "action-block settings-card" },
    OwnerActionRow(
      "Last-service stamp",
      button(
        {
          class: "action",
          disabled: () => serviceBusy.val || !serviceCanAct(),
          onkeydown: refuseKeyRepeat,
          onclick: () => {
            if (armed.val !== READ_STAMP_KEY) {
              arm(READ_STAMP_KEY);
              return;
            }
            if (!armDwellElapsed()) {
              return;
            }
            armed.val = "";
            void performStampRead();
          },
        },
        () =>
          working.val
            ? "⏳  Working…"
            : armed.val === READ_STAMP_KEY
              ? `⚠️  Tap again — ${READ_STAMP_NOTES.confirm}`
              : "Read last-service stamp"
      ),
      () => (armed.val === READ_STAMP_KEY ? "Confirm" : "Read")
    ),
    StampOutcome(),
    div(div({ class: "action-note" }, READ_STAMP_NOTES.does), div())
  );
}

const { button, div } = van.tags;
const READ_STAMP_KEY = "action:read-service-stamp";
const working = van.state(false);
/** @typedef {import("../../src/vcu/service-actions.ts").ServiceStamp} ServiceStamp */
const stampOutcome = van.state(/** @type {{text:string,stamp:ServiceStamp|null}|null} */ (null));

export const READ_STAMP_NOTES = {
  confirm: "ask the A8 for the service stamp",
  does: "Reads four identifiers on the A8 in one go, decoded. Read-only. The date and odometer AT THE LAST SERVICE — not the current mileage, which is already live as odometer_can_km and needs no read. Read for the first time on 2026-09-08: all four answered zero, so no service point has ever been set on this bike (docs/service-stamp.md).",
};

export async function refreshLastService() {
  stampOutcome.val = null;
  armed.val = "";
  await refreshServiceStatus();
}

async function performStampRead() {
  stampOutcome.val = null;
  working.val = true;
  try {
    await serviceOperation(async () => {
      const payload = await sendServiceWrite(
        new URLSearchParams({ action: "read-service-stamp", confirm: "read-service-stamp" })
      );
      stampOutcome.val = {
        text: payload?.result?.message ?? payload?.message ?? "Could not reach the Pi.",
        stamp: payload?.result?.stamp?.before ?? null,
      };
    });
  } finally {
    working.val = false;
  }
}

function StampOutcome() {
  return div(() => {
    const answer = stampOutcome.val;
    if (!answer) {
      return div();
    }
    return div(
      div({ class: "action-note caution" }, answer.text),
      answer.stamp ? div({ class: "action-note output" }, describeStampEvidence(answer.stamp).join("\n")) : div()
    );
  });
}
