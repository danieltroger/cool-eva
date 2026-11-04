// @ts-check
// Measured notice fallback and full Settings access: docs/dashboard-header.md.
import van from "../vendor/van-1.6.1.js";
import { settings } from "../lib/settings.js";
import { systemStatus } from "../lib/store.js";
import { pageReloadRequired } from "../lib/page-reload.js";
import { setupNoticePending } from "../lib/setup-notice.js";
import { destination, openDestination } from "../lib/destination.js";
import { destinationTitle } from "./destination-page.js";

const { button, div, span } = van.tags;
const svgTags = van.tags("http://www.w3.org/2000/svg");

export function HeaderTitle() {
  const label = span({ class: "notice-label" });
  const count = span({ class: "notice-count" });
  const measure = span({ class: "notice-measure", "aria-hidden": "true" });
  const icon = svgTags.svg(
    { viewBox: "0 0 24 24", width: 14, height: 14, "aria-hidden": "true" },
    svgTags.path({ fill: "none", stroke: "currentColor", "stroke-width": 2 })
  );
  const notice = button({ class: "header-notice", onclick: () => openDestination("settings") }, icon, label, count);
  const brand = span({ class: "brand" }, "Cool Eva");
  const slot = div({ class: "brand-slot" }, brand, notice, measure);
  const context = { slot, brand, notice, label, count, measure, icon };
  const observer = new ResizeObserver(() => fitTitle(context));
  observer.observe(slot);
  document.fonts.addEventListener("loadingdone", () => fitTitle(context));
  van.derive(() => {
    const fault = systemStatus.val?.settingsFault ?? settings.val?.fault;
    const reload = pageReloadRequired.val;
    const setup = setupNoticePending();
    const total = Number(!!fault) + Number(reload) + Number(setup);
    const type = fault ? "Fault" : reload ? "Reload" : "Setup";
    const description = fault ? "Settings fault" : reload ? "Page reload required" : "First-open setup information";
    const parked = !!destination.val;
    notice.hidden = parked || total === 0;
    brand.hidden = !parked && total > 0;
    brand.textContent = parked ? destinationTitle() : "Cool Eva";
    label.textContent = type;
    measure.textContent = type;
    count.textContent = total > 1 ? String(total) : "";
    count.hidden = total <= 1;
    notice.style.color = fault ? "var(--bad)" : reload ? "var(--warn)" : "var(--label)";
    notice.setAttribute("aria-label", `${description}; ${total} notice${total === 1 ? "" : "s"}. Open Settings.`);
    icon
      .querySelector("path")
      ?.setAttribute(
        "d",
        fault
          ? "M12 3 2 21h20L12 3Zm0 6v5m0 3v1"
          : reload
            ? "M20 7v6h-6M20 13a8 8 0 1 0-2 5"
            : "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v1m0 3v6"
      );
    notice.dataset.compact = "true";
    requestAnimationFrame(() => fitTitle(context));
  });
  return slot;
}

/** @typedef {{slot:HTMLDivElement,brand:HTMLSpanElement,notice:HTMLButtonElement,label:HTMLSpanElement,count:HTMLSpanElement,measure:HTMLSpanElement,icon:Element}} TitleContext */
/** @param {TitleContext} context */
function fitTitle(context) {
  if (!context.slot.isConnected) return;
  if (!context.notice.hidden) {
    const required =
      14 +
      4 +
      context.measure.getBoundingClientRect().width +
      (context.count.hidden ? 0 : 4 + context.count.getBoundingClientRect().width);
    context.notice.dataset.compact = String(required > context.slot.clientWidth);
  } else if (!destination.rawVal) {
    context.brand.style.letterSpacing = "";
    if (context.brand.scrollWidth > context.slot.clientWidth) {
      context.brand.style.letterSpacing = "0";
    }
  }
}
