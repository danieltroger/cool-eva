import type { CommandResult } from "./nmcli.ts";

// Turns a collected set of command results into the text that lands in
// /home/pi/cool-eva/wifi-diag/<timestamp>.txt. Pure: results and a timestamp in, a
// string out — no I/O, no clock, no child process — so scripts/check-wifi-diag.ts builds
// a dump from fixtures on a laptop with no radio. ./collect.ts runs the commands and
// ./dump.ts writes the file. docs/wifi.md.

/** Marks a line whose secret was removed. Asserted by the check, so it is a constant. */
export const REDACTED = "<redacted by wifi-diag>";

/**
 * Settings whose value is a secret, matched on the key that precedes it.
 *
 * ⚠️ This is the SECOND line of defence and not the first. `nmcli connection show`
 * prints the PSK as `<hidden>` unless `--show-secrets` is passed, and ./collect.ts never
 * passes it — that is the control that actually matters. This catches the case where a
 * future command, or a journal line, carries one anyway.
 */
const SECRET_KEY_PATTERN =
  /^(\s*[\w.-]*(?:psk|password|passwd|secret|wep-key\d?|private-key-password)[\w.-]*\s*[:=]\s*)(.+)$/i;

export interface WifiDumpInput {
  /** Wall-clock instant for the header, from the caller. Date.now() is stamping, not timing. */
  at: number;
  /** The Pi's uptime in seconds, so a dump says which boot it belongs to. */
  uptimeSeconds: number;
  results: readonly CommandResult[];
}

/**
 * Builds the dump.
 *
 * ⚠️ A failed command is REPORTED, never dropped. The exit code, the stderr, the timeout
 * and the truncation all reach the file, because "that command is missing" and "that
 * command printed nothing" are different answers and a reader three weeks later cannot
 * tell them apart from an absence.
 */
export function buildWifiDump(input: WifiDumpInput): string {
  const lines: string[] = [];
  lines.push(`cool-eva wifi diagnostic`);
  lines.push(`taken at:  ${new Date(input.at).toISOString()}`);
  lines.push(`uptime:    ${input.uptimeSeconds.toFixed(0)} s`);
  lines.push(`commands:  ${input.results.length}`);
  const unhappy = input.results.filter(result => result.exitCode !== 0 || result.timedOut || result.truncated);
  lines.push(`problems:  ${unhappy.length === 0 ? "none" : unhappy.map(result => result.command).join(", ")}`);
  lines.push("");
  for (const result of input.results) {
    lines.push("=".repeat(78));
    lines.push(`$ ${result.command}`);
    const notes: string[] = [`exit ${result.exitCode === null ? "?" : result.exitCode}`, `${result.elapsedMs} ms`];
    if (result.timedOut) {
      notes.push("TIMED OUT — output below is whatever arrived before the kill");
    }
    if (result.truncated) {
      notes.push("TRUNCATED — output outgrew the buffer and is SHORT OF THE TRUTH");
    }
    lines.push(`  (${notes.join(", ")})`);
    lines.push("=".repeat(78));
    const stdout = redactSecrets(result.stdout).trimEnd();
    lines.push(stdout === "" ? "(no output)" : stdout);
    const stderr = redactSecrets(result.stderr).trimEnd();
    if (stderr !== "") {
      lines.push("--- stderr ---");
      lines.push(stderr);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Replaces the value of any secret-looking setting, keeping the key so the shape survives. */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .map(line => {
      const match = SECRET_KEY_PATTERN.exec(line);
      return match === null ? line : `${match[1]}${REDACTED}`;
    })
    .join("\n");
}
