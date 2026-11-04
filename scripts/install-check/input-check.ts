import assert from "node:assert/strict";
import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { runInTerminal } from "./terminal.ts";

export async function checkInstallerInput(directory: string, repository: string): Promise<void> {
  const pair = await promisify(generateKeyPair)("x25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const script = join(directory, "input.ts");
  await writeFile(
    script,
    `import assert from 'node:assert/strict';
import {readInstallChoices} from ${JSON.stringify(join(repository, "src/install/questions.ts"))};
try { const choices=await readInstallChoices(false); assert.equal(choices.home?.ssid,'Synthetic Home'); assert.equal(choices.home?.password,'fixture-home-secret'); assert.equal(choices.hotspot?.ssid,'Synthetic Phone'); assert.equal(choices.hotspot?.password,'fixture-phone-secret'); assert(choices.rideLogPublicKeyPem?.startsWith('-----BEGIN PUBLIC KEY-----')); console.log('INPUT_ACCEPTED'); }
catch(error) { console.error(error instanceof Error ? error.message : 'Input refused'); process.exitCode=1; }
`
  );
  const networkAnswers: [string, string][] = [
    ["Home Wi-Fi name (required): ", "Synthetic Home\n"],
    ["Home Wi-Fi password (hidden): ", "fixture-home-secret\n"],
    ["Phone hotspot name (required): ", "Synthetic Phone\n"],
    ["Phone hotspot password (hidden): ", "fixture-phone-secret\n"],
  ];
  const accepted = await terminalRun(script, [
    ...networkAnswers,
    ["Public key: ", publicKey],
    ["Type BACKED UP to confirm: ", "BACKED UP\n"],
    ["Optional coolant probes already wired? Type WIRED to enable, or Enter for off: ", "\n"],
    [
      "Optional radiator fan/driver already wired? It can start automatically. Type WIRED to enable, or Enter for off: ",
      "\n",
    ],
  ]);
  assert.equal(accepted.code, 0, accepted.output);
  assert.match(accepted.output, /INPUT_ACCEPTED/);
  const rejected = await terminalRun(script, [
    ...networkAnswers,
    ["Public key: ", privateKey],
    ["Type BACKED UP to confirm: ", "BACKED UP\n"],
    ["Optional coolant probes already wired? Type WIRED to enable, or Enter for off: ", "\n"],
    [
      "Optional radiator fan/driver already wired? It can start automatically. Type WIRED to enable, or Enter for off: ",
      "\n",
    ],
  ]);
  assert.notEqual(rejected.code, 0, rejected.output);
  assert.match(rejected.output, /public key, not a private key/);
  const unconfirmed = await terminalRun(script, [
    ...networkAnswers,
    ["Public key: ", publicKey],
    ["Type BACKED UP to confirm: ", "NO\n"],
    ["Optional coolant probes already wired? Type WIRED to enable, or Enter for off: ", "\n"],
    [
      "Optional radiator fan/driver already wired? It can start automatically. Type WIRED to enable, or Enter for off: ",
      "\n",
    ],
  ]);
  assert.notEqual(unconfirmed.code, 0, unconfirmed.output);
  assert.match(unconfirmed.output, /Back up your private key before enabling recording/);
  for (const result of [accepted, rejected]) {
    assert(!result.output.includes("fixture-home-secret"), "Home password was echoed");
    assert(!result.output.includes("fixture-phone-secret"), "Hotspot password was echoed");
    assert(!result.output.includes("BEGIN PRIVATE KEY"), "Rejected private-key paste was echoed");
  }
  const blank = await terminalRun(script, [["Home Wi-Fi name (required): ", "\n"]]);
  assert.notEqual(blank.code, 0);
  assert.match(blank.output, /both network names/);
}

async function terminalRun(
  script: string,
  answers: [string, string][]
): Promise<{ code: number | null; output: string }> {
  return runInTerminal(process.execPath, ["--experimental-strip-types", script], answers);
}
