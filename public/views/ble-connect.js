// @ts-check

import van from "../vendor/van-1.6.1.js";
import {
  BLE_MODE,
  bluetoothAvailable,
  chooseAndConnect,
  onBleStatus,
  rememberSecret,
  storedSecret,
} from "../lib/ble-link.js";

// The controls a BLE-served dashboard needs and a wifi-served one does not: a way to pick
// the Pi (Web Bluetooth will only open its chooser from a tap) and somewhere to type the
// shared secret. Both render nothing unless ../lib/ble-link.js says this page is in
// BLE mode, so the Pi-served dashboard is unchanged.

const { button, div, form, h2, input, span } = van.tags;

/** @typedef {import("../lib/ble-link.js").BleStatus} BleStatus */

const bleStatus = van.state(/** @type {BleStatus} */ ("off"));
const bleDetail = van.state("");

if (BLE_MODE) {
  onBleStatus((status, detail) => {
    bleStatus.val = status;
    bleDetail.val = detail;
  });
}

function connectNow() {
  chooseAndConnect().catch(error => {
    // The chooser being dismissed is a rider changing their mind, not a fault.
    if (/** @type {Error} */ (error).name === "NotFoundError") {
      console.log("ble: device chooser dismissed");
      return;
    }
    console.warn("ble: connect failed", error);
    bleDetail.val = /** @type {Error} */ (error).message;
  });
}

/** In the header, beside the link dot, until the link is up. */
export function BleHeaderButton() {
  if (!BLE_MODE) {
    return span();
  }
  return () =>
    bleStatus.val === "connected" ? span() : button({ class: "ble-connect", onclick: connectNow }, "Connect");
}

/** The sheet's Bluetooth section: the secret, the state of the link, and a Connect button. */
export function BleSection() {
  if (!BLE_MODE) {
    return div();
  }
  if (!bluetoothAvailable()) {
    return div(
      h2({ class: "sheet-heading" }, "Bluetooth"),
      div(
        { class: "action-note caution" },
        "This browser has no Web Bluetooth. On iPhone use the Cool Eva app or Bluefy; on Android, Chrome."
      )
    );
  }
  return div(
    h2({ class: "sheet-heading" }, "Bluetooth"),
    // A form, so Return in the field connects and a password manager can offer to keep
    // the secret. The secret is saved from the form at submit rather than on `change`,
    // which a Return keypress does not reliably fire first.
    form(
      {
        onsubmit: (/** @type {SubmitEvent} */ event) => {
          event.preventDefault();
          const field = /** @type {HTMLFormElement} */ (event.target).elements.namedItem("secret");
          rememberSecret(/** @type {HTMLInputElement} */ (field).value);
          connectNow();
        },
      },
      // Hidden, and fixed: password managers file a secret under a username, and without
      // one they offer to save it under nothing in particular.
      input({ type: "text", name: "username", autocomplete: "username", value: "cool-eva", hidden: true }),
      input({
        class: "probe-input",
        type: "password",
        name: "secret",
        autocomplete: "current-password",
        placeholder: "BLE secret (BLE_SECRET on the Pi)",
        value: storedSecret(),
      }),
      button({ class: "action", type: "submit" }, () =>
        bleStatus.val === "connected" ? "Connected — choose another Pi" : "Connect to the Pi"
      )
    ),
    () =>
      div(
        { class: bleStatus.val === "refused" ? "action-note failure" : "action-note" },
        describe(bleStatus.val, bleDetail.val)
      )
  );
}

/**
 * @param {BleStatus} status
 * @param {string} detail
 */
function describe(status, detail) {
  switch (status) {
    case "off":
      return "Not connected. The secret is stored on this phone only.";
    case "connecting":
      return "Connecting…";
    case "connected":
      return detail ? `Connected to ${detail}.` : "Connected.";
    case "refused":
      return `Refused by the Pi: ${detail}`;
    case "lost":
      return detail ? `Link lost: ${detail}. Reconnecting while this page is open.` : "Link lost. Reconnecting.";
  }
}
