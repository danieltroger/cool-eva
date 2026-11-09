// @ts-check
import van from "../vendor/van-1.6.1.js";
import { formatServiceStampDate } from "../lib/service-stamp.js";
import { OwnerActionRow } from "./owner-action.js";
import {
  bikeReadBusy,
  bikeReadCaption,
  bikeReadRefusal,
  bikeServicePermission,
  bikeServiceStamp,
  refreshBikeReadings,
} from "../lib/bike-readings.js";
import { sendServiceWrite, serviceBusy, serviceOperation } from "../lib/service-client.js";

export function LastServiceRead() {
  return div(
    { class: "action-block settings-card" },
    OwnerActionRow(
      "Last service",
      button(
        {
          class: "action",
          "data-bike-read": "service",
          disabled: () => !!bikeReadBusy.val || serviceBusy.val || bikeReadRefusal(bikeServicePermission.val) !== null,
          onclick: () => void performStampRead(),
        },
        div(
          {
            role: "status",
            class: () => (stampDate() === "fault" ? "raw-fault" : ""),
            title: () => bikeServiceStamp.val?.implausible ?? "",
          },
          stampDate
        )
      ),
      () => (serviceBusy.val && !bikeReadBusy.val ? "Read busy" : bikeReadCaption(bikeServicePermission.val, "service"))
    ),
    () => (message.val ? div({ class: "action-note", role: "status", title: messageTitle.val }, message.val) : div())
  );
}

const { button, div } = van.tags;
const message = van.state("");
const messageTitle = van.state("");

function stampDate() {
  const stored = bikeServiceStamp.val;
  if (!stored) return "No stored reading";
  return stored.confirmed ? formatServiceStampDate(stored) : "Unconfirmed";
}

async function performStampRead() {
  if (bikeReadBusy.rawVal || serviceBusy.rawVal || bikeReadRefusal(bikeServicePermission.rawVal) !== null) return;
  bikeReadBusy.val = "service";
  message.val = "";
  try {
    await serviceOperation(async () => {
      const payload = await sendServiceWrite(
        new URLSearchParams({ action: "read-service-stamp", confirm: "read-service-stamp" })
      );
      messageTitle.val = payload?.result?.message ?? payload?.message ?? "Could not reach the Pi.";
      message.val = payload?.result?.succeeded ? "Read complete" : "Read failed";
    });
  } finally {
    bikeReadBusy.val = "";
    await refreshBikeReadings();
  }
}
