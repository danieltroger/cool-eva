// @ts-check
import { generateLogKeyPair } from "./key-crypto.js";

/** @typedef {import("./key-crypto.js").LogKeyPair} LogKeyPair */
/** @typedef {{ pair: LogKeyPair | null, generation: number, downloads: Map<string, number> }} PageState */

export function startKeyPage() {
  /** @type {PageState} */
  const state = { pair: null, generation: 0, downloads: new Map() };
  const generate = button("generate");
  generate.disabled = !window.isSecureContext || crypto.subtle === undefined;
  element("status").textContent = generate.disabled
    ? "This browser cannot make keys here. Open the HTTPS page in an updated browser, or use the laptop script below."
    : "Ready. Keys are made only when you tap Generate keys.";
  generate.addEventListener("click", () => void generateKeys(state));
  button("private-download").addEventListener("click", () => downloadKey(state, "private"));
  button("public-download").addEventListener("click", () => downloadKey(state, "public"));
  checkbox("backed-up").addEventListener("change", () => {
    button("public-download").disabled = !checkbox("backed-up").checked;
  });
  button("theme").addEventListener("click", toggleTheme);
  window.addEventListener("pagehide", () => clearKeys(state));
  window.addEventListener("pageshow", event => {
    if (event.persisted) {
      clearKeys(state);
      element("status").textContent =
        "This tab’s keys were cleared when you left. Use your saved files. Generating again makes a different pair.";
    }
  });
}

/** @param {PageState} state */
async function generateKeys(state) {
  if (button("generate").disabled || state.pair !== null) return;
  button("generate").disabled = true;
  const generation = ++state.generation;
  element("status").textContent = "Making your keys on this device…";
  try {
    const pair = await generateLogKeyPair();
    if (generation !== state.generation) return;
    state.pair = pair;
    element("public-pem").textContent = pair.publicPem;
    element("fingerprint").textContent = pair.fingerprint;
    element("keys").hidden = false;
    element("status").textContent = "Your pair is ready. Save the private file and a recoverable backup below.";
  } catch (error) {
    if (generation !== state.generation) return;
    console.warn(
      "key page: browser X25519 generation or export failed",
      error instanceof Error ? error.name : "unknown error"
    );
    element("status").textContent =
      "This browser could not make an X25519 key pair. No files were created. Update your browser or use the laptop script below.";
    button("generate").disabled = false;
  }
}

/** @param {PageState} state @param {"private" | "public"} kind */
function downloadKey(state, kind) {
  if (state.pair === null || button(`${kind}-download`).disabled) return;
  const contents = kind === "private" ? state.pair.privatePem : state.pair.publicPem;
  const url = URL.createObjectURL(new Blob([contents], { type: "application/x-pem-file" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ride-log-key.${kind}.pem`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Safari can consume the Blob after click returns. Keep retrying the same pair.
  state.downloads.set(
    url,
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      state.downloads.delete(url);
    }, 60_000)
  );
  element(`${kind}-status`).textContent = "Download started. Check your Downloads folder.";
  if (kind === "private") {
    checkbox("backed-up").disabled = false;
  }
}

/** @param {PageState} state */
function clearKeys(state) {
  state.generation += 1;
  state.pair = null;
  for (const [url, timer] of state.downloads) {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
  state.downloads.clear();
  element("keys").hidden = true;
  element("public-pem").textContent = "";
  element("fingerprint").textContent = "";
  element("private-status").textContent = "";
  element("public-status").textContent = "";
  checkbox("backed-up").checked = false;
  checkbox("backed-up").disabled = true;
  button("public-download").disabled = true;
  button("generate").disabled = !window.isSecureContext || crypto.subtle === undefined;
}

function toggleTheme() {
  const current =
    document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = current === "dark" ? "light" : "dark";
}

/** @param {string} elementId */
function element(elementId) {
  const found = document.getElementById(elementId);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`Missing key-page element: ${elementId}`);
  }
  return found;
}

/** @param {string} elementId */
function button(elementId) {
  const found = element(elementId);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Expected a key-page button: ${elementId}`);
  }
  return found;
}

/** @param {string} elementId */
function checkbox(elementId) {
  const found = element(elementId);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`Expected a key-page checkbox: ${elementId}`);
  }
  return found;
}

startKeyPage();
