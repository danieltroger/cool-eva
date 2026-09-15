// The preview harness, part 1 of 4: the browser this page is standing in.
//
// Injected verbatim into both preview templates by scripts/build-service-preview.ts, which
// substitutes its placeholder for these four files joined in the order
// scripts/preview-harness.ts declares. ONE script scope, so that order is the whole of the
// temporal-dead-zone contract — and so is what each template must declare above the
// placeholder. Both are named in preview-harness.ts; read it before moving anything here.
//
// Why one harness at all, and what the two hand-kept copies had drifted into by the time
// they were merged: docs/diagnostics-and-checks.md §11.10.
//
// ⚠️ Two kinds of string may not appear anywhere in these files, and
// scripts/check-preview-harness.ts fails the build if one does. First, any token shaped like a
// builder placeholder — an upper-case name wrapped in a pair of underscores on each side, which
// this sentence deliberately does not spell, because writing one here IS the mistake: String
// .replace substitutes only the first occurrence, so a second copy is left live in the generated
// page. Second, the expression that imports the dashboard's entry module — check-preview-
// fixtures.ts decides which contract a page is held to by searching the built source for it, so a
// harness that merely MENTIONED it would make the annotated sheet answer for endpoints it does
// not serve.

// The file may be opened straight off a disk, where nothing has set a viewport and
// iOS would lay it out at 980 px and shrink it. Idempotent: a host that already
// provides one wins.
if (!document.querySelector('meta[name="viewport"]')) {
  const meta = document.createElement("meta");
  meta.name = "viewport";
  meta.content = "width=device-width, initial-scale=1, viewport-fit=cover";
  (document.head || document.documentElement).appendChild(meta);
}

// ── what a tap would have done ───────────────────────────────────────────────

let toastTimer = 0;
function toast(text) {
  const node = document.getElementById("pv-toast");
  if (!node) {
    return;
  }
  node.textContent = text;
  node.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("on"), 3200);
}

// Two controls in the sheet hand the file to the browser by navigating — the ride log
// and the parameter export. A shadowed `location` inside those modules (see the
// bundler) turns the navigation into this, so a tap says what it would have done
// instead of blanking the page.
const __previewLocation = {
  protocol: "http:",
  host: "eva.local",
  pathname: "/",
  search: "",
  // ⚠️ The router reads location.hash and the annotated harness never ran the
  // router — it mounted views directly — so this was missing and the whole app
  // died on startRouting with "Cannot read properties of undefined". Delegated to
  // the real hash so the tab bar works and the back button does what it does on
  // the Pi; a preview where you cannot change tab is not a preview of the app.
  get hash() {
    return window.location.hash;
  },
  set hash(next) {
    window.location.hash = next;
  },
  get href() {
    return `http://eva.local/${window.location.hash}`;
  },
  set href(target) {
    toast(`Preview — this would download ${target} from the Pi.`);
  },
};
window.__previewLocation = __previewLocation;

// The one real link in the sheet ("Open the full parameter table →"). Captured rather
// than rewritten, so the anchor the design uses is the anchor that renders.
document.addEventListener(
  "click",
  event => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    // ⚠️ SCOPED PER PAGE, and it has to be. The annotated sheet wraps each panel in
    // .pv-stage and wants only those links caught; the whole-dashboard page has no such
    // class, and a filter on it there matched nothing — so "Open the full parameter
    // table →" navigated straight out of the preview to a file:// 404. A page that
    // catches everything says so with null rather than by naming a class it never writes.
    if (anchor && (INTERCEPT_LINKS_WITHIN === null || anchor.closest(INTERCEPT_LINKS_WITHIN))) {
      event.preventDefault();
      toast(`Preview — this would open ${anchor.getAttribute("href")} on the Pi.`);
    }
  },
  true
);

// ── one instance of the dashboard per panel ──────────────────────────────────
//
// views/vcu-write.js keeps `dangerOpen`, `armed`, `wanted` and the rest as
// module-level van states. Two panels sharing one instance would share the fold and
// the armed button — so each panel gets the whole module graph to itself.

function instantiate() {
  const cache = Object.create(null);
  function imp(path) {
    const existing = cache[path];
    if (existing) {
      return existing;
    }
    const exports = (cache[path] = {});
    const factory = __MODULES[path];
    if (!factory) {
      throw new Error(`preview: no module ${path}`);
    }
    factory(exports, imp);
    return exports;
  }
  return imp;
}

/** Seeds the store from one WebSocket snapshot, then walks a finished ride past the trip counters. */
async function seed(imp, connectTheStore) {
  const store = imp("lib/store.js");
  const trip = imp("lib/trip.js");

  // ⚠️ The CALLER decides, because connect() is not idempotent and a second link applies
  // every heartbeat twice, for ever. A page whose entry point connects for itself passes
  // false. docs/diagnostics-and-checks.md §11.10 has what the double link cost.
  if (connectTheStore) {
    store.connect();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // 37.4 km in 41 minutes, which is what the last ride was. updateTrip() credits at
  // most two seconds per call — the guard that stops a backgrounded tab claiming its
  // whole absence as riding time — so the ride is walked past it at its own pace.
  const odometer = store.signalState("odometer_can_km");
  const speed = store.signalState("gps_speed_kmh");
  const start = 14849.4 - 37.4;
  const steps = 1230;
  odometer.val = { value: start, unit: "km", group: "drive", ts: NOW };
  speed.val = { value: 0, unit: "km/h", group: "gps", ts: NOW };
  trip.updateTrip(0);
  for (let step = 1; step <= steps; step++) {
    const fraction = step / steps;
    odometer.val = { value: start + 37.4 * fraction, unit: "km", group: "drive", ts: NOW };
    // A shape rather than a constant, so "Top" is a speed the bike actually reached
    // on the way rather than the average with a digit changed.
    const kmh = 46 + 34 * Math.sin(fraction * Math.PI * 3) + (step === 812 ? 42 : 0);
    speed.val = { value: Math.max(4, kmh), unit: "km/h", group: "gps", ts: NOW };
    trip.updateTrip(step * 2000);
  }
  odometer.val = { value: 14849.4, unit: "km", group: "drive", ts: NOW };
  speed.val = { value: 0, unit: "km/h", group: "gps", ts: NOW };
}
