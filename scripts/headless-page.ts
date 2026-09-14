import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { WebSocket as WsClient } from "ws";
import { monotonicNow, since } from "../src/monotonic.ts";

// A phone-sized page in whatever browser the machine already has, driven over raw CDP.
//
// No dependency is added: `ws` already ships for the dashboard socket, and the browser is
// the one the person or the CI image already installed. Why that mattered enough to hand-roll
// a CDP client, and why nothing built on this is in `npm test`: docs/diagnostics-and-checks.md
// §11.8.

/** Long enough for a cold start on a loaded laptop; short enough to fail a hung one. */
const LAUNCH_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 30_000;
/** How long a page gets to render what is being waited for. */
const RENDER_TIMEOUT_MS = 15_000;
/** How long a SIGKILLed browser gets to actually be gone before its profile is removed. */
const EXIT_TIMEOUT_MS = 5_000;

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
  browser: ChildProcess;
  connection: Connection;
  sessionId: string;
  userDataDir: string;
}

/**
 * Starts `browserPath`, opens one page at `viewport`, and hands back the handle the rest of
 * this module takes.
 *
 * ⚠️ The binary is a PARAMETER rather than resolved here, so the caller that prints which
 * browser it is measuring in prints the one that actually ran. findBrowser() called twice
 * can answer twice — $CHROME_PATH set between the two, a PATH entry appearing — and a log
 * line naming a browser nothing opened is the kind of evidence this repo throws away.
 */
export async function openHeadlessPage(viewport: Viewport, browserPath: string): Promise<HeadlessPage> {
  const userDataDir = await mkdtemp(join(tmpdir(), "cool-eva-headless-"));
  const browser = launchBrowser(browserPath, userDataDir);
  // ⚠️ Everything below can throw — a launch that prints no endpoint, a socket that never
  // opens, a CDP command that times out — and the browser is already running by then. Without
  // this the caller's own finally never sees a page to close, and each failed run leaves an
  // orphaned headless Chrome and a ~700 kB profile behind. CI reclaims both with the
  // container; the laptop this is usually run on does not.
  try {
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
    const page: HeadlessPage = { browser, connection, sessionId, userDataDir };
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
  } catch (error) {
    await endBrowser(browser, userDataDir);
    throw error;
  }
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
export async function waitOnPage(page: HeadlessPage, expression: string, what: string): Promise<void> {
  const start = monotonicNow();
  for (;;) {
    if (await evaluateOnPage(page, expression)) {
      return;
    }
    if (since(start) > RENDER_TIMEOUT_MS) {
      throw new Error(`waited ${Math.round(since(start))} ms for ${what} and it never came true: ${expression}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Closes the browser and removes its profile. Safe to call twice. */
export async function closePage(page: HeadlessPage): Promise<void> {
  page.connection.socket.close();
  await endBrowser(page.browser, page.userDataDir);
}

/**
 * Kills the browser, waits for it to be GONE, then removes its profile.
 *
 * ⚠️ The wait is not politeness. `kill()` only delivers the signal; Chrome still has the
 * profile open for a moment afterwards and keeps writing into it, so an immediate `rm -rf`
 * races a directory that is still growing — `ENOTEMPTY` on `<profile>/Default` failed one
 * otherwise-green run here, at the very end, with every assertion already passed.
 *
 * ⚠️ And the removal is loud rather than fatal, because this is called from the caller's
 * `finally`: a throw here would replace whatever the check was actually reporting with a
 * complaint about a temp directory.
 */
async function endBrowser(browser: ChildProcess, userDataDir: string): Promise<void> {
  browser.kill("SIGKILL");
  await new Promise<void>(resolve => {
    if (browser.exitCode !== null || browser.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      console.warn(`headless-page: ${browser.pid} did not exit within ${EXIT_TIMEOUT_MS} ms of SIGKILL`);
      resolve();
    }, EXIT_TIMEOUT_MS);
    browser.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    await rm(userDataDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`headless-page: could not remove the temporary profile ${userDataDir}: ${String(error)}`);
  }
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
      finish();
      reject(new Error(`${browserPath} printed no DevTools endpoint in ${LAUNCH_TIMEOUT_MS} ms. It said: ${seen}`));
    }, LAUNCH_TIMEOUT_MS);
    const onError = (error: Error) => {
      finish();
      reject(new Error(`could not start ${browserPath}: ${error.message}`));
    };
    const onExit = (code: number | null) => {
      finish();
      reject(new Error(`${browserPath} exited ${code} before saying where to connect. It said: ${seen}`));
    };
    const onData = (chunk: string) => {
      seen += chunk;
      // ⚠️ Anchored on the END OF THE LINE, not on `ws://…` alone: stderr arrives in chunks
      // that can split anywhere, and a bare URL match would happily return half an endpoint
      // — which connects to nothing and fails 20 s later as a launch timeout.
      const found = /DevTools listening on (ws:\/\/\S+)\r?\n/.exec(seen);
      if (found !== null) {
        finish();
        resolve(found[1]);
      }
    };
    /**
     * Stops listening once the endpoint is in hand — but keeps DRAINING stderr.
     *
     * ⚠️ `resume()` is the load-bearing half. Removing the only `data` listener pauses the
     * pipe, and Chrome talks for the whole run: it would fill the 64 kB buffer, block in
     * write(2), and hang the check with no output at all. What the removal buys is that the
     * regex stops re-scanning an ever-growing buffer on every chunk, and that a SIGKILL at
     * the end no longer builds a rejection nobody is waiting for out of all of `seen`.
     */
    const finish = () => {
      clearTimeout(timer);
      browser.off("error", onError);
      browser.off("exit", onExit);
      stderr.off("data", onData);
      stderr.resume();
    };
    browser.on("error", onError);
    browser.on("exit", onExit);
    stderr.setEncoding("utf8");
    stderr.on("data", onData);
  });
}

async function connectTo(url: string): Promise<Connection> {
  // handshakeTimeout, because `ws` applies none: without it a browser that printed its
  // endpoint and then wedged leaves this promise pending for ever, and the check hangs
  // rather than failing.
  const socket = new WsClient(url, { handshakeTimeout: LAUNCH_TIMEOUT_MS });
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
  if (candidate.includes("/")) {
    return (await isExecutable(candidate)) ? candidate : null;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const full = join(directory, candidate);
    if (await isExecutable(full)) {
      return full;
    }
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    // Routine: this is the loop that asks where a browser is, and most answers are "not here".
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EACCES") {
      console.warn(`headless-page: could not look at ${path}: ${String(error)}`);
    }
    return false;
  }
}
