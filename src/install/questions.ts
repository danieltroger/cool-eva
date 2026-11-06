import { open, type FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import { validatePublicKey } from "../settings/public-key.ts";

export async function readInstallChoices(
  hasSettings: boolean,
  networksSaved = { home: false, hotspot: false }
): Promise<InstallChoices> {
  const terminal = await open("/dev/tty", "r+");
  try {
    console.log("Save home Wi-Fi and a 2.4 GHz phone hotspot. Passwords are never shown or logged.");
    const home = await readNetwork(terminal, "Home Wi-Fi", networksSaved.home);
    const hotspot = await readNetwork(terminal, "Phone hotspot", networksSaved.hotspot);
    const rideLogPublicKeyPem = await publicKey(terminal);
    if (rideLogPublicKeyPem) {
      await terminal.write("Back up the PRIVATE key on your computer. Type BACKED UP to confirm: ");
      if ((await line(terminal)) !== "BACKED UP") {
        throw new Error("Back up your private key before enabling recording. No new key was saved.");
      }
    }
    if (!rideLogPublicKeyPem && !hasSettings) {
      console.log("NOT SAVING RIDES until a public key is added in Settings.");
    }
    let accessories: { coolantProbesEnabled: boolean; radiatorFanEnabled: boolean } | null = null;
    if (!hasSettings) {
      await terminal.write("Optional coolant probes already wired? Type WIRED to enable, or Enter for off: ");
      const coolantProbesEnabled = await wiredChoice(terminal);
      await terminal.write(
        "Optional radiator fan/driver already wired? It can start automatically. Type WIRED to enable, or Enter for off: "
      );
      const radiatorFanEnabled = await wiredChoice(terminal);
      accessories = { coolantProbesEnabled, radiatorFanEnabled };
    }
    return { home, hotspot, rideLogPublicKeyPem, accessories };
  } finally {
    await terminal.close();
  }
}

export interface WifiChoice {
  ssid: string;
  password: string;
}
export interface InstallChoices {
  home: WifiChoice | null;
  hotspot: WifiChoice | null;
  rideLogPublicKeyPem: string | null;
  accessories: { coolantProbesEnabled: boolean; radiatorFanEnabled: boolean } | null;
}

async function wiredChoice(terminal: FileHandle): Promise<boolean> {
  const answer = await line(terminal);
  if (answer !== "" && answer !== "WIRED") {
    throw new Error("Type WIRED only for the documented connected hardware, or leave it off.");
  }
  return answer === "WIRED";
}

async function readNetwork(terminal: FileHandle, label: string, optional: boolean): Promise<WifiChoice | null> {
  await terminal.write(`${label} name${optional ? " (blank keeps existing)" : " (required)"}: `);
  const ssid = await line(terminal);
  if (!ssid && optional) return null;
  if (!ssid) {
    throw new Error("Fresh setup needs both network names. Keep the phone hotspot in 2.4 GHz mode.");
  }
  if (Buffer.byteLength(ssid) > 32 || /[\0\r\n]/.test(ssid)) {
    throw new Error("Wi-Fi names must be 1–32 bytes.");
  }
  await echo(terminal, false);
  let password: string;
  try {
    await terminal.write(`${label} password (hidden): `);
    password = await line(terminal);
  } finally {
    await echo(terminal, true);
    await terminal.write("\n");
  }
  if (
    /[\0\r\n]/.test(password) ||
    (!/^[a-f0-9]{64}$/i.test(password) && (Buffer.byteLength(password) < 8 || Buffer.byteLength(password) > 63))
  ) {
    throw new Error("Wi-Fi passwords must have 8–63 bytes, or 64 hexadecimal digits.");
  }
  return { ssid, password };
}

async function publicKey(terminal: FileHandle): Promise<string | null> {
  await echo(terminal, false);
  let contents = "";
  try {
    await terminal.write(
      "Paste ONLY the ride-log PUBLIC key (ride-log-key.public.pem), ending with END PUBLIC KEY.\nLeave blank to keep the existing key or configure recording later in Settings.\nPublic key: "
    );
    const first = await line(terminal);
    if (!first) return null;
    if (!/^-----BEGIN (PUBLIC|(?:[A-Z]+ )?PRIVATE) KEY-----$/.test(first)) {
      throw new Error("Paste the PUBLIC key, starting with BEGIN PUBLIC KEY, or leave it blank.");
    }
    contents = first + "\n";
    while (!/-----END [A-Z ]*KEY-----/.test(contents) && contents.length <= 16 * 1024) {
      contents += (await line(terminal)) + "\n";
    }
    return validatePublicKey(contents);
  } finally {
    await echo(terminal, true);
    await terminal.write("\n");
  }
}

async function line(terminal: FileHandle): Promise<string> {
  const buffer = Buffer.alloc(16 * 1024 + 1);
  const { bytesRead } = await terminal.read(buffer, 0, buffer.length, null);
  if (!bytesRead || bytesRead > 16 * 1024) {
    throw new Error("Setup input ended or was too long.");
  }
  return buffer
    .subarray(0, bytesRead)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

async function echo(terminal: FileHandle, enabled: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("stty", [enabled ? "echo" : "-echo"], { stdio: [terminal.fd, "ignore", "pipe"] });
    child.stderr!.on("data", () => console.warn("setup: terminal echo setting failed"));
    child.once("error", reject);
    child.once("exit", code => (code === 0 ? resolve() : reject(new Error("Cannot protect terminal input."))));
  });
}
