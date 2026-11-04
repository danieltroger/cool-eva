// @ts-check
import van from "../vendor/van-1.6.1.js";

const { div } = van.tags;

/** @param {string} subject @param {HTMLButtonElement} control @param {() => string} caption */
export function OwnerActionRow(subject, control, caption) {
  // Move the existing reactive caption with its binding; the original handler and safety gates stay on the button.
  const status = div({ class: "settings-note owner-action-status" }, ...control.childNodes);
  control.classList.remove("action", "action-quiet");
  control.classList.add("settings-button");
  van.add(control, caption);
  return div({ class: "settings-row owner-action" }, div(div(subject), status), control);
}

/** @param {string} subject @param {HTMLButtonElement} control @param {() => string} caption */
export function OwnerActionCard(subject, control, caption) {
  return div({ class: "settings-card" }, OwnerActionRow(subject, control, caption));
}
