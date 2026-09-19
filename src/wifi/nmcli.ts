import { execFile } from "child_process";
import { monotonicNow, since } from "../monotonic.ts";

// The only place in src/wifi that starts a process. Everything else takes strings.
//
// ⚠️ `execFile` and never `exec`: the argument list is passed to the kernel as a vector,
// so an SSID with a space, a quote or a `;` in it is an argument rather than shell syntax.
// ../can/link-status.ts uses `exec` with an interpolated interface name and gets away with
// it because that name is a constant; here the hotspot SSID comes from the environment.
//
// ⚠️ Absolute paths, because `iw` and `rfkill` live in /usr/sbin and that is NOT on the
// PATH of a non-login shell — measured on this Pi while pulling the 2026-09-19 evidence,
// where `iw dev wlan0 link` came back `command not found` over ssh and worked as
// `/usr/sbin/iw`. The service runs as root under systemd, whose PATH is its own business
// and not something to depend on.

export const NMCLI = "/usr/bin/nmcli";
export const IW = "/usr/sbin/iw";
export const RFKILL = "/usr/sbin/rfkill";
export const IP = "/usr/sbin/ip";
export const JOURNALCTL = "/usr/bin/journalctl";

/**
 * How much output one command may produce.
 *
 * ⚠️ Node's default is 1 MB and it KILLS the child on overflow rather than truncating,
 * so the command that overflows is the one whose output is lost — and the command most
 * likely to overflow is the journal dump, whose size grows with exactly the trouble this
 * feature exists to capture. The worst 20-minute NetworkManager/wpa_supplicant window on
 * 2026-09-19 was 335 067 bytes, so 1 MB was not reached that day; a noisier fault is not
 * a reason to come home with nothing. 8 MB, plus `--lines` on the journal call, plus a
 * marker in the dump so a truncated capture says so instead of looking complete.
 */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface CommandResult {
  /** The command as a human reads it in the dump — never re-executed from this string. */
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Wall time, for spotting the call that hung rather than failed. */
  elapsedMs: number;
  /** The timeout fired, so the output is whatever arrived before the kill. */
  timedOut: boolean;
  /** MAX_OUTPUT_BYTES was hit, so stdout is short of the truth. */
  truncated: boolean;
}

/**
 * Runs one read-only command and always resolves.
 *
 * ⚠️ It does not throw and it does not swallow: a non-zero exit, a timeout and a
 * truncation each come back as data, and every caller puts them in the dump. A wifi
 * diagnostic whose failures are invisible is worse than none, because it looks complete.
 */
export function runCommand(file: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  // ⚠️ monotonicNow(), not Date.now(). This is a DURATION, and ../gps/clock.ts steps
  // this process's wall clock with `date -u -s` whenever satellite time disagrees — a
  // step landing inside a call would print a negative or hour-long elapsed time into the
  // dump, next to the command whose slowness is the thing being diagnosed. ../monotonic.ts.
  const startedAt = monotonicNow();
  const command = [file, ...args].join(" ");
  return new Promise(resolve => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        const elapsedMs = Math.round(since(startedAt));
        if (error === null) {
          resolve({ command, exitCode: 0, stdout, stderr, elapsedMs, timedOut: false, truncated: false });
          return;
        }
        // ⚠️ `code` is a NUMBER for a child that exited non-zero and a STRING for
        // execFile's own failures — ENOENT when the binary is missing,
        // ERR_CHILD_PROCESS_STDIO_MAXBUFFER when the output outgrew the buffer. A
        // `killed` child that is not a truncation is the timeout firing. Both spellings
        // matter, which is why the exit code is `number | null` rather than a number.
        const truncated = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const timedOut = error.killed === true && !truncated;
        resolve({
          command,
          exitCode: typeof error.code === "number" ? error.code : null,
          stdout,
          stderr: stderr === "" ? error.message : stderr,
          elapsedMs,
          timedOut,
          truncated,
        });
      }
    );
  });
}
