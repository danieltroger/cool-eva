import assert from "node:assert/strict";
import { createDecipheriv, createPublicKey, diffieHellman, hkdf, type KeyObject } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { sshCommand, type GuestSsh } from "./ssh.ts";

export async function verifyEncryptedFixture(
  guest: GuestSsh,
  privateKey: KeyObject,
  publicKey: KeyObject
): Promise<void> {
  const program = `import {readFile,readdir} from 'node:fs/promises';
import {initEncryptedLog,appendReading,closeEncryptedLog} from './src/storage/encrypted-log.ts';
const settings=JSON.parse(await readFile('/var/lib/cool-eva/state/settings.json','utf8'));
const directory='/var/tmp/cool-eva-encryption-fixture';
if(!await initEncryptedLog({directory,publicKeyPem:settings.values.rideLogPublicKeyPem,clockTrust:()=> 'never-synced'})){throw new Error('Fixture recording disabled');}
appendReading(1700000000000,'pack_v',51.25,'V','Battery','can');
await closeEncryptedLog();
const names=await readdir(directory);if(names.length!==1){throw new Error('Expected one encrypted fixture');}
console.log('COOL_EVA_ENCRYPTED='+(await readFile(directory+'/'+names[0])).toString('base64'));`;
  const encoded = Buffer.from(program).toString("base64");
  const output = await sshCommand(
    guest,
    `cd /opt/cool-eva/current && printf '%s' '${encoded}' | base64 -d | sudo runtime/bin/node --experimental-strip-types --input-type=module`,
    90_000
  );
  const encodedLog = /^COOL_EVA_ENCRYPTED=([A-Za-z0-9+/=]+)$/m.exec(output)?.[1];
  assert(encodedLog, "Guest must actually seal a log with the installed public key");
  const bytes = Buffer.from(encodedLog, "base64");
  assert.equal(bytes.subarray(0, 8).toString(), "COOLEVA1");
  const ephemeralRaw = bytes.subarray(8, 40);
  const recipientRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const ephemeral = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), ephemeralRaw]),
    type: "spki",
    format: "der",
  });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const derived = await promisify(hkdf)(
    "sha256",
    shared,
    Buffer.concat([ephemeralRaw, recipientRaw]),
    Buffer.from("cool-eva ride log v1"),
    32
  );
  const payloadBytes = bytes.readUInt32LE(52);
  assert.equal(bytes.length, 56 + payloadBytes + 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(derived), bytes.subarray(40, 52));
  decipher.setAAD(bytes.subarray(0, 56));
  decipher.setAuthTag(bytes.subarray(-16));
  const plaintext = await promisify(gunzip)(
    Buffer.concat([decipher.update(bytes.subarray(56, -16)), decipher.final()])
  );
  assert.deepEqual(JSON.parse(plaintext.toString().split("\n")[1]), [1700000000000, "pack_v", 51.25, 0]);
}
