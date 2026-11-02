// @ts-check

import van from "../vendor/van-1.6.1.js";
import {
  BLE_MODE,
  bluetoothAvailable,
  chooseAndConnect,
  deviceChosen,
  onBleStatus,
  reconnect,
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

/** The secret field's id, so the header button can put the cursor in it. */
const SECRET_FIELD_ID = "ble-secret";

/** Set when a connect was refused for want of a secret; the menu's note says what to do. */
const secretWanted = van.state(false);

/**
 * Connects, or — when there is no secret yet, or the Pi refused the one there is — sends
 * the rider to the field instead. The chooser is only shown with a secret in hand, and
 * only once per page: correcting a secret reconnects to the Pi already chosen.
 * @param {() => void} [openMenu] how to get the field on screen, when it is not already
 */
function connectNow(openMenu) {
  if (storedSecret() === "") {
    askForSecret(openMenu);
    return;
  }
  secretWanted.val = false;
  const attempt = deviceChosen() && bleStatus.val !== "connected" ? reconnect() : chooseAndConnect();
  attempt.catch(error => {
    // The chooser being dismissed is a rider changing their mind, not a fault.
    if (/** @type {Error} */ (error).name === "NotFoundError") {
      console.log("ble: device chooser dismissed");
      return;
    }
    console.warn("ble: connect failed", error);
    if (bleStatus.val === "refused") {
      askForSecret(openMenu);
      return;
    }
    bleDetail.val = /** @type {Error} */ (error).message;
  });
}

/** @param {(() => void) | undefined} openMenu */
function askForSecret(openMenu) {
  secretWanted.val = true;
  openMenu?.();
  // After the sheet has rendered open: a field still under `visibility: hidden` takes no
  // focus. iOS will not raise the keyboard for a focus outside a tap, but the cursor is
  // there and the note below says what it is for.
  setTimeout(() => document.getElementById(SECRET_FIELD_ID)?.focus(), 150);
}

/**
 * In the header, beside the link dot, until the link is up.
 * @param {() => void} openMenu opens the menu sheet, where the secret is typed
 */
export function BleHeaderButton(openMenu) {
  if (!BLE_MODE) {
    return span();
  }
  return () =>
    bleStatus.val === "connected"
      ? span()
      : button({ class: "ble-connect", onclick: () => connectNow(openMenu) }, "Connect");
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
        id: SECRET_FIELD_ID,
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
      secretWanted.val && bleStatus.val !== "refused"
        ? div({ class: "action-note caution" }, "Enter the Pi's BLE secret above, then tap Connect to the Pi.")
        : div(
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
      return `Refused by the Pi: ${detail}. Correct the secret above and tap Connect again.`;
    case "lost":
      return detail ? `Link lost: ${detail}. Reconnecting while this page is open.` : "Link lost. Reconnecting.";
  }
}
