// @ts-check
import van from "../vendor/van-1.6.1.js";
import { openDestination } from "../lib/destination.js";
import { SettingsCard } from "./settings-fields.js";

const { a, button } = van.tags;

export function AccessExplanation() {
  return SettingsCard(
    "Who can control my bike?",
    "Cool Eva does not have individual user accounts. Anyone who can reach it over your Wi-Fi or phone hotspot can change settings and request changes to the motorcycle. Anyone with your Cool Eva Bluetooth access code has the same access over Bluetooth. Confirmations help prevent accidental taps; they do not stop another device from sending its own requests. Use a network you trust and do not make Cool Eva accessible from the public internet. Motorcycle commands still pass the app’s checks and are recorded in its change history.",
    a(
      {
        class: "settings-link",
        href: "https://github.com/danieltroger/cool-eva/blob/main/LICENSE",
        target: "_blank",
        rel: "noopener",
      },
      "Licence and no warranty →"
    )
  );
}

export function AccessLink() {
  return button(
    { class: "settings-link", onclick: () => openDestination("settings", "access") },
    "Who can control my bike? →"
  );
}
