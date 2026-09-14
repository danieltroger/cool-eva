import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { WebSocket as WsClient } from "ws";
import { monotonicNow, since } from "../src/monotonic.ts";

// A phone-sized page in whatever browser the machine already has, driven over raw CDP.
//
// ⚠️ docs/diagnostics-and-checks.md §11.6 says there is no browser in the suite, and that
// stays true: nothing built on this is in scripts/run-checks.ts. It exists for the one
// question no amount of source-reading answers — how wide the rendered page actually is —
// and it adds NO dependency. `ws` already ships for the dashboard socket, and the browser
// is the one the person or the CI image already installed. When there is none, the caller
// is told so and fails; a measurement that was not taken is never reported as one.

/** Long enough for a cold start on a loaded laptop; short enough to fail a hung one. */
const LAUNCH_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Where a browser might be, in the order tried. `CHROME_PATH` wins over all of them and is
 * how you point this at a different build; bare names are looked up along `PATH`.
 */
const BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  /** Mobile emulation, i.e. the page gets the viewport meta a phone gives it. */
  mobile: boolean;
}

interface PendingCommand {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface Connection {
  socket: WsClient;
  pending: Map<number, PendingCommand>;
  lastId: number;
}

export interface HeadlessPage {
  /** The binary this page is running in, for the log line that says what was measured. */
  browserPath: string;
  browser: ChildProcess;
  connection: Connection;
  sessionId: string;
  userDataDir: string;
}

/**
 * Starts a browser, opens one page at `viewport`, and hands back the handle the rest of
 * this module takes. Throws when no browser can be found — see findBrowser().
 */
export async function openHeadlessPage(viewport: Viewport): Promise<HeadlessPage> {
  const browserPath = await findBrowser();
  if (browserPath === null) {
    throw new Error(
      `no browser found. Tried $CHROME_PATH and ${BROWSER_CANDIDATES.join(", ")} — ` +
        `install one or set CHROME_PATH to it`
    );
  }
  const userDataDir = await mkdtemp(join(tmpdir(), "cool-eva-headless-"));
  const browser = launchBrowser(browserPath, userDataDir);
  const connection = await connectTo(await devToolsUrl(browser, browserPath));
  const target = await sendCommand(connection, "Target.createTarget", { url: "about:blank" });
  const attached = await sendCommand(connection, "Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;
  if (typeof sessionId !== "string") {
    throw new Error(`Target.attachToTarget answered without a sessionId: ${JSON.stringify(attached)}`);
  }
  const page: HeadlessPage = { browserPath, browser, connection, sessionId, userDataDir };
  await sendCommand(connection, "Page.enable", {}, sessionId);
  // ⚠️ Before the first navigation, not after: an override applied to a rendered page
  // relays it out, and a layout measured across that relayout has been wrong once already.
  await sendCommand(
    connection,
    "Emulation.setDeviceMetricsOverride",
    {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.mobile,
    },
    sessionId
  );
  return page;
}

/** The browser this would use, or null when there is none. Exported so a caller can say so. */
export async function findBrowser(): Promise<string | null> {
  const fromEnvironment = process.env.CHROME_PATH;
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    // Named explicitly, so a broken path is an error rather than a reason to look elsewhere:
    // falling back here would measure in a browser nobody asked for.
    try {
      await access(fromEnvironment, constants.X_OK);
    } catch (error) {
      throw new Error(`CHROME_PATH names ${fromEnvironment}, which cannot be run: ${String(error)}`);
    }
    return fromEnvironment;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    const resolved = await resolveExecutable(candidate);
    if (resolved !== null) {
      return resolved;
    }
  }
  return null;
}

/** Navigates, and waits for the document to finish loading. */
export async function gotoPage(page: HeadlessPage, url: string): Promise<void> {
  const result = await sendCommand(page.connection, "Page.navigate", { url }, page.sessionId);
  if (typeof result.errorText === "string") {
    throw new Error(`could not open ${url}: ${result.errorText}`);
  }
  await waitOnPage(page, "document.readyState === 'complete'", `${url} to finish loading`);
}

/** Runs `expression` in the page and returns what it evaluated to, awaiting a promise. */
export async function evaluateOnPage(page: HeadlessPage, expression: string): Promise<unknown> {
  const reply = await sendCommand(
    page.connection,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    page.sessionId
  );
  if (reply.exceptionDetails !== undefined) {
    throw new Error(`the page threw: ${JSON.stringify(reply.exceptionDetails)}`);
  }
  const result = reply.result;
  if (typeof result !== "object" || result === null) {
    throw new Error(`Runtime.evaluate answered without a result: ${JSON.stringify(reply)}`);
  }
  return (result as Record<string, unknown>).value;
}

/**
 * Polls `expression` until it is true. The dashboard renders from a stubbed fetch, so
 * "loaded" and "drawn" are not the same event and there is none to listen for.
 */
export async function waitOnPage(
  page: HeadlessPage,
  expression: string,
  what: string,
  timeoutMs = 15_000
): Promise<void> {
  const start = monotonicNow();
  for (;;) {
    if (await evaluateOnPage(page, expression)) {
      return;
    }
    if (since(start) > timeoutMs) {
      throw new Error(`waited ${Math.round(since(start))} ms for ${what} and it never came true: ${expression}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Closes the browser and removes its profile. Safe to call twice. */
export async function closePage(page: HeadlessPage): Promise<void> {
  page.connection.socket.close();
  page.browser.kill("SIGKILL");
  await rm(page.userDataDir, { recursive: true, force: true });
}

function launchBrowser(browserPath: string, userDataDir: string): ChildProcess {
  // --no-sandbox: the page is a file this repo just generated and loads nothing over the
  // network, and the sandbox wants unprivileged user namespaces, which CI images restrict.
  // Port 0 so two runs on one machine cannot collide; the browser prints the one it took.
  return spawn(
    browserPath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

/** The browser announces its debugging endpoint on stderr and nowhere else. */
async function devToolsUrl(browser: ChildProcess, browserPath: string): Promise<string> {
  const stderr = browser.stderr;
  if (stderr === null) {
    throw new Error(`${browserPath} was started without a stderr to read its endpoint from`);
  }
  return await new Promise<string>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => {
      reject(new Error(`${browserPath} printed no DevTools endpoint in ${LAUNCH_TIMEOUT_MS} ms. It said: ${seen}`));
    }, LAUNCH_TIMEOUT_MS);
    browser.on("error", error => {
      clearTimeout(timer);
      reject(new Error(`could not start ${browserPath}: ${error.message}`));
    });
    browser.on("exit", code => {
      clearTimeout(timer);
      reject(new Error(`${browserPath} exited ${code} before saying where to connect. It said: ${seen}`));
    });
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      seen += chunk;
      const found = /ws:\/\/[^\s]+/.exec(seen);
      if (found !== null) {
        clearTimeout(timer);
        resolve(found[0]);
      }
    });
  });
}

async function connectTo(url: string): Promise<Connection> {
  const socket = new WsClient(url, { maxPayload: 256 * 1024 * 1024 });
  const connection: Connection = { socket, pending: new Map(), lastId: 0 };
  socket.on("message", data => receive(connection, data.toString()));
  socket.on("error", error => failEveryPending(connection, error));
  socket.on("close", () => failEveryPending(connection, new Error("the browser closed the debugging socket")));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return connection;
}

async function sendCommand(
  connection: Connection,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string
): Promise<Record<string, unknown>> {
  connection.lastId += 1;
  const id = connection.lastId;
  const message: Record<string, unknown> = { id, method, params };
  if (sessionId !== undefined) {
    message.sessionId = sessionId;
  }
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(new Error(`${method} did not answer within ${COMMAND_TIMEOUT_MS} ms`));
    }, COMMAND_TIMEOUT_MS);
    connection.pending.set(id, {
      method,
      resolve: result => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: error => {
        clearTimeout(timer);
        reject(error);
      },
    });
    connection.socket.send(JSON.stringify(message), error => {
      if (error !== undefined && error !== null) {
        connection.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`could not send ${method}: ${error.message}`));
      }
    });
  });
}

/** One frame from the browser: a reply to a command, or an event nothing here subscribes to. */
function receive(connection: Connection, raw: string) {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    console.warn(`headless-page: ignoring a frame that is not JSON (${String(error)}): ${raw.slice(0, 200)}`);
    return;
  }
  if (typeof message !== "object" || message === null) {
    console.warn(`headless-page: ignoring a frame that is not an object: ${raw.slice(0, 200)}`);
    return;
  }
  const fields = message as Record<string, unknown>;
  if (typeof fields.id !== "number") {
    return;
  }
  const waiting = connection.pending.get(fields.id);
  if (waiting === undefined) {
    console.warn(`headless-page: a reply arrived for command ${fields.id}, which nothing is waiting for`);
    return;
  }
  connection.pending.delete(fields.id);
  if (fields.error !== undefined) {
    waiting.reject(new Error(`${waiting.method} failed: ${JSON.stringify(fields.error)}`));
    return;
  }
  waiting.resolve(
    typeof fields.result === "object" && fields.result !== null ? (fields.result as Record<string, unknown>) : {}
  );
}

/** A dead socket must not leave a command waiting for the 30 s timeout to notice. */
function failEveryPending(connection: Connection, error: Error) {
  for (const [id, waiting] of connection.pending) {
    connection.pending.delete(id);
    waiting.reject(new Error(`${waiting.method}: ${error.message}`));
  }
}

async function resolveExecutable(candidate: string): Promise<string | null> {
  const directories = candidate.includes("/") ? [""] : (process.env.PATH ?? "").split(delimiter);
  for (const directory of directories) {
    const full = directory === "" ? candidate : join(directory, candidate);
    try {
      await access(full, constants.X_OK);
      return full;
    } catch (error) {
      // Routine: this is the loop that asks where a browser is, and most answers are "not here".
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EACCES") {
        console.warn(`headless-page: could not look at ${full}: ${String(error)}`);
      }
    }
  }
  return null;
}
