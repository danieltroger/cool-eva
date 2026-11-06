import { writeFile } from "node:fs/promises";

export async function writeSimulatorCapture(path: string, durationMs = 8_000): Promise<void> {
  const lines: string[] = [];
  for (let elapsed = 0; elapsed <= durationMs; elapsed += 100) {
    const pressed = elapsed >= 200 && elapsed < 6_500;
    for (const [id, data] of [
      [0x104, [0, 0, 0, 0, 0, 0, 0, 0]],
      [0x102, [pressed ? 32 : 0, 0, 0, 0, 0, 0, 0, 0]],
      [0x400, [2, 1, pressed ? 1 : 0, 0, 0, 0, 0, 0]],
      [0x200, [23, 46, 98, 27, 0x0b, 0xb8, 0, 200]],
      [0x660, [1, 2, 25, 27, 23, 0, 0, 27]],
      [0x7e8, [3, 0x41, 0x46, 61, 0, 0, 0, 0]],
      [0x7df, [2, 1, 0x46, 0, 0, 0, 0, 0]],
    ] satisfies [number, number[]][]) {
      lines.push(captureLine(elapsed, id, data));
    }
    if (elapsed % 1_000 === 0) {
      for (const data of syntheticGpsFrames(elapsed / 1_000)) {
        lines.push(captureLine(elapsed, 0x410, data));
      }
    }
  }
  lines.push("capture interrupted", "(2026-01-01 00:00:08.000001) can0 200 [8] 17");
  await writeFile(path, lines.join("\n"));
}

export function captureLine(elapsedMs: number, id = 0x104, data = [0, 0, 0, 0, 0, 0, 0, 0]): string {
  const date = new Date(Date.UTC(2026, 0, 1) + elapsedMs).toISOString().replace("T", " ").replace("Z", "000");
  return `(${date}) can0 ${id.toString(16).padStart(3, "0").toUpperCase()} [${data.length}] ${data.map(byte => byte.toString(16).padStart(2, "0")).join(" ")}`;
}

// Constructed position, never copied from a journey. GPS time advances at the replay's 1x rate.
function syntheticGpsFrames(seconds: number): number[][] {
  const date = new Date(Date.UTC(2030, 0, 1, 12) + seconds * 1_000);
  const year = date.getUTCFullYear() - 2000;
  const hour = date.getUTCHours();
  return [
    [26, 0, 0, 0, 0, 0, 64, 0],
    [26, 1, 1, 0, 0, 0, 128, 0],
    [
      26,
      254,
      0,
      date.getUTCSeconds() << 2,
      date.getUTCMinutes() | ((hour & 3) << 6),
      (hour >> 2) | (date.getUTCDate() << 3),
      (date.getUTCMonth() + 1) | ((year & 15) << 4),
      (year >> 4) | (8 << 3),
    ],
  ];
}

export function routedPaths(source: string, receiver = "url.pathname"): string[] {
  const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...new Set([...source.matchAll(new RegExp(`${escaped} === "([^"\\n]+)"`, "g"))].map(match => match[1])),
  ].sort();
}
