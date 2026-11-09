// @ts-check
import van from "../vendor/van-1.6.1.js";
import { formatServiceStampDate } from "../lib/service-stamp.js";
import { OwnerActionRow } from "./owner-action.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
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
      "Last service",
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
        () => (working.val ? "⏳  Working…" : armed.val === READ_STAMP_KEY ? "Confirm read" : "Read last-service stamp")
      ),
      () => (armed.val === READ_STAMP_KEY ? "Confirm" : "Read")
    ),
    StampOutcome()
  );
}

const { button, div } = van.tags;
const READ_STAMP_KEY = "action:read-service-stamp";
const working = van.state(false);
/** @typedef {import("../../src/vcu/service-actions.ts").ServiceStamp} ServiceStamp */
const stampOutcome = van.state(/** @type {{text:string,stamp:ServiceStamp|null}|null} */ (null));

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
    const value = formatServiceStampDate(answer.stamp);
    return div(
      { class: `action-note${value === "fault" ? " raw-fault" : ""}`, title: answer.text, role: "status" },
      value
    );
  });
}
