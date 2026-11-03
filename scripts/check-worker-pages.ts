import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
await checkDeploymentRevision();
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
  "✓ local Workers serve dashboard bytes/MIME/404s and key CSP; browser generation, retry, pagehide revocation, BFCache reset and unsupported/export failures pass; stale deploy skips without hiding fetch errors"
);

async function checkDeploymentRevision(): Promise<void> {
  const workflow = await readFile(join(projectDirectory, ".github/workflows/workers.yml"), "utf8");
  const guard = /        id: revision\n        run: \|\n((?:          [^\n]*\n)+)/.exec(workflow);
  assert.ok(guard, "the deployment revision guard must be exercised from the real workflow");
  const script = guard[1]
    .split("\n")
    .map(line => line.slice(10))
    .join("\n");
  const fakeGit = `git() {
    if [ "$1" = "fetch" ]; then
      return "$WORKERS_TEST_FETCH_STATUS"
    fi
    printf '%s\\n' "$WORKERS_TEST_MAIN_REVISION"
  }\n`;
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-workflow-check-"));
  try {
    for (const current of [true, false]) {
      const outputPath = join(directory, `${current}.txt`);
      const { stdout } = await promisify(execFile)("bash", ["-e", "-o", "pipefail", "-c", fakeGit + script], {
        timeout: 5000,
        env: {
          ...process.env,
          GITHUB_SHA: "1".repeat(40),
          GITHUB_OUTPUT: outputPath,
          WORKERS_TEST_MAIN_REVISION: (current ? "1" : "2").repeat(40),
          WORKERS_TEST_FETCH_STATUS: "0",
        },
      });
      assert.equal(await readFile(outputPath, "utf8"), `current=${current}\n`);
      if (!current) {
        assert.match(stdout, /::notice::Skipping deployment/);
      }
    }
    await assert.rejects(
      promisify(execFile)("bash", ["-e", "-o", "pipefail", "-c", fakeGit + script], {
        timeout: 5000,
        env: { ...process.env, WORKERS_TEST_FETCH_STATUS: "23" },
      }),
      error => {
        const failure = error as Error & { code?: number };
        return failure.code === 23;
      },
      "a failed fetch must still fail the guard"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkBrowserFlow(page: HeadlessPage): Promise<void> {
  await evaluateOnPage(
    page,
    `
    window.fixtureDownloads = [];
    window.fixtureNames = [];
    window.fixtureObjectUrls = [];
    window.fixtureRevokedUrls = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      window.fixtureDownloads.push(blob);
      const url = createObjectURL(blob);
      window.fixtureObjectUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = url => { window.fixtureRevokedUrls.push(url); revokeObjectURL(url); };
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
    "window.fixtureOutstandingUrls = window.fixtureObjectUrls.filter(url => !window.fixtureRevokedUrls.includes(url));"
  );
  assert.equal(
    await evaluateOnPage(page, "window.fixtureOutstandingUrls.length > 0"),
    true,
    "the pagehide check must start with live download URLs"
  );
  await evaluateOnPage(page, "window.dispatchEvent(new PageTransitionEvent('pagehide'));");
  assert.equal(
    await evaluateOnPage(
      page,
      "document.getElementById('keys').hidden && document.getElementById('public-pem').textContent === '' && !document.getElementById('generate').disabled"
    ),
    true,
    "pagehide alone must clear key state before any pageshow"
  );
  assert.equal(
    await evaluateOnPage(page, "window.fixtureOutstandingUrls.every(url => window.fixtureRevokedUrls.includes(url))"),
    true,
    "pagehide alone must revoke every outstanding download URL"
  );
  await evaluateOnPage(page, "document.getElementById('generate').click();");
  await waitOnPage(
    page,
    "!document.getElementById('keys').hidden",
    "another explicit generation before BFCache restore"
  );
  await evaluateOnPage(page, "window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));");
  assert.equal(
    await evaluateOnPage(
      page,
      "document.getElementById('keys').hidden && document.getElementById('public-pem').textContent === '' && !document.getElementById('generate').disabled"
    ),
    true,
    "BFCache restore independently clears keys without generating a replacement"
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
