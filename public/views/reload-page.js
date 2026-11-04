// @ts-check
import van from "../vendor/van-1.6.1.js";
import { pageReloadRequired } from "../lib/page-reload.js";

const { div, button } = van.tags;

export function ReloadPageNotice() {
  return () =>
    pageReloadRequired.val
      ? div(
          { class: "settings-page" },
          div(
            { class: "settings-card settings-row" },
            div(
              "Reload the page",
              div({ class: "settings-note" }, "This dashboard is out of date. Reload before trying an action again.")
            ),
            button({ class: "settings-button", onclick: () => location.reload() }, "Reload")
          )
        )
      : div();
}
