// @ts-check
import van from "../vendor/van-1.6.1.js";

const geometry = van.state("");
/** @type {HTMLDivElement | null} */
let probe = null;
const standalone = matchMedia("(display-mode: standalone)");
/** @typedef {Navigator & {standalone?: boolean}} StandaloneNavigator */

export function ScreenGeometry() {
  if (!probe) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.append(probe);
    // One probe/listener set for the page lifetime, including repeated Settings visits.
    window.addEventListener("resize", scheduleMeasurement);
    window.addEventListener("orientationchange", scheduleMeasurement);
    standalone.addEventListener("change", scheduleMeasurement);
    window.visualViewport?.addEventListener("resize", scheduleMeasurement);
  }
  measureGeometry();
  return van.tags.div({ class: "settings-note screen-geometry" }, () => geometry.val);
}

function scheduleMeasurement() {
  requestAnimationFrame(measureGeometry);
}

function measureGeometry() {
  if (!probe) return;
  const style = getComputedStyle(probe);
  const insets = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat);
  const iosStandalone = /** @type {StandaloneNavigator} */ (navigator).standalone;
  const viewport = window.visualViewport;
  const visualSize = viewport
    ? `${Math.round(viewport.width * 10) / 10}×${Math.round(viewport.height * 10) / 10}`
    : "unavailable";
  geometry.val = `${innerWidth}×${innerHeight} · DPR ${devicePixelRatio} · insets T/R/B/L ${insets.join("/")} px · display-mode standalone: ${standalone.matches ? "yes" : "no"} · iOS standalone: ${iosStandalone === undefined ? "unavailable" : iosStandalone ? "yes" : "no"} · screen ${screen.width}×${screen.height} · visualViewport ${visualSize}`;
}
