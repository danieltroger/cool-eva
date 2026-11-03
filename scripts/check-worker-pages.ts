import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closePage,
  evaluateOnPage,
  findBrowser,
  gotoPage,
  openHeadlessPage,
  waitOnPage,
  type HeadlessPage,
} from "./headless-page.ts";
import { checkLogKeyRoundTrip } from "./log-key-roundtrip.ts";
import { startWorkerPreview, stopWorkerPreview } from "./worker-preview.ts";
import type { LogKeyPair } from "../workers/keys/public/key-crypto.js";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const browserPath = await findBrowser();
assert.ok(browserPath, "Workers browser smoke check requires Chrome");
const keyPreview = await startWorkerPreview("keys");
try {
  const response = await fetch(keyPreview.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${keyPreview.url}/_headers`)).status, 404);
  const page = await openHeadlessPage({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, browserPath);
  try {
    await gotoPage(page, keyPreview.url);
    assert.equal(await evaluateOnPage(page, "innerWidth"), 390);
    await checkBrowserFlow(page);
  } finally {
    await closePage(page);
  }
} finally {
  await stopWorkerPreview(keyPreview);
}
const dashboardPreview = await startWorkerPreview("dashboard");
try {
  for (const path of ["index.html", "app.js", "lib/ble-link.js", "style.css", "manifest.webmanifest"]) {
    const response = await fetch(`${dashboardPreview.url}/${path}`);
    assert.equal(response.status, 200, `dashboard asset ${path}`);
    assert.ok(
      Buffer.from(await response.arrayBuffer()).equals(await readFile(join(projectDirectory, "public", path))),
      `dashboard asset ${path} must be served verbatim`
    );
    if (path.endsWith(".js")) {
      assert.match(response.headers.get("content-type") ?? "", /javascript/);
    }
  }
  for (const path of ["missing.js", "status", "../package.json", "ride-log-key.private.pem"]) {
    assert.equal((await fetch(`${dashboardPreview.url}/${path}`)).status, 404, `do not publish ${path}`);
  }
} finally {
  await stopWorkerPreview(dashboardPreview);
}
console.log(
  "✓ local Workers serve dashboard bytes/MIME/404s and key CSP; phone-width browser generation, retry, backup gate, lifetime and unsupported/export failures pass"
);

async function checkBrowserFlow(page: HeadlessPage): Promise<void> {
  await evaluateOnPage(
    page,
    `
    window.fixtureDownloads = [];
    window.fixtureNames = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { window.fixtureDownloads.push(blob); return createObjectURL(blob); };
    HTMLAnchorElement.prototype.click = function () { window.fixtureNames.push(this.download); };
    window.fixtureResourceCount = performance.getEntriesByType("resource").length;
    document.getElementById("generate").click();
  `
  );
  await waitOnPage(page, "!document.getElementById('keys').hidden", "the real browser key pair");
  assert.equal(await evaluateOnPage(page, "document.getElementById('public-download').disabled"), true);
  await evaluateOnPage(
    page,
    `
    document.getElementById("private-download").click();
    document.dispatchEvent(new Event("visibilitychange"));
    document.getElementById("private-download").click();
    document.getElementById("generate").click();
    document.getElementById("backed-up").click();
    document.getElementById("public-download").click();
  `
  );
  assert.deepEqual(await evaluateOnPage(page, "window.fixtureNames"), [
    "ride-log-key.private.pem",
    "ride-log-key.private.pem",
    "ride-log-key.public.pem",
  ]);
  assert.equal(
    await evaluateOnPage(
      page,
      "Promise.all(window.fixtureDownloads.slice(0, 2).map(blob => blob.text())).then(contents => contents[0] === contents[1])"
    ),
    true,
    "download retry must retain the pair"
  );
  const pair = (await evaluateOnPage(
    page,
    `Promise.all(window.fixtureDownloads.map(blob => blob.text())).then(contents => ({ privatePem: contents[0], publicPem: contents[2], fingerprint: document.getElementById("fingerprint").textContent }))`
  )) as LogKeyPair;
  await checkLogKeyRoundTrip(pair);
  assert.equal(
    await evaluateOnPage(page, "performance.getEntriesByType('resource').length === window.fixtureResourceCount"),
    true,
    "generation/download must cause no network requests"
  );
  assert.equal(await evaluateOnPage(page, "localStorage.length + sessionStorage.length"), 0);
  assert.equal(await evaluateOnPage(page, "document.cookie"), "");
  assert.deepEqual(await evaluateOnPage(page, "indexedDB.databases()"), []);
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "navigator.serviceWorker.getRegistrations().then(items => items.map(item => item.scope))"
    ),
    []
  );
  assert.equal(
    await evaluateOnPage(page, "fetch(location.origin + '/csp-probe').then(() => false, () => true)"),
    true,
    "the real CSP must block connections"
  );
  assert.equal(await evaluateOnPage(page, "document.body.textContent.includes('BEGIN PRIVATE KEY')"), false);
  await evaluateOnPage(
    page,
    "window.dispatchEvent(new PageTransitionEvent('pagehide')); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));"
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "document.getElementById('keys').hidden && document.getElementById('public-pem').textContent === '' && !document.getElementById('generate').disabled"
    ),
    true,
    "leaving clears keys without generating on return"
  );
  for (const method of ["generateKey", "exportKey"]) {
    await evaluateOnPage(
      page,
      `window.fixtureOriginal = crypto.subtle.${method}; crypto.subtle.${method} = () => Promise.reject(new DOMException("Synthetic unsupported operation", "NotSupportedError")); document.getElementById("generate").click();`
    );
    await waitOnPage(
      page,
      "document.getElementById('status').textContent.includes('No files were created')",
      `${method} failure guidance`
    );
    assert.equal(await evaluateOnPage(page, "document.getElementById('keys').hidden"), true);
    await evaluateOnPage(page, `crypto.subtle.${method} = window.fixtureOriginal;`);
  }
}
