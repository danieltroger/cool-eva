import { generateKeyPairSync } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// Run this ONCE, on the laptop — never on the Pi.
//
// Writes the X25519 keypair that protects the ride log. The private key is the
// only thing that can ever decrypt it: back it up somewhere that isn't this
// laptop (password manager), because losing it makes every logged ride
// permanently unreadable. That is the property that makes a stolen bike useless
// to a thief, so there is deliberately no recovery path.
//
// Sync calls are fine here: this is a one-off CLI, not the event-loop-bound app.

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, "..");

const privateKeyPath = resolve(projectDir, "ride-log-key.private.pem");
const publicKeyPath = resolve(projectDir, "ride-log-key.public.pem");

if (existsSync(privateKeyPath)) {
  console.error(`Refusing to overwrite ${privateKeyPath}`);
  console.error("That key is the only way to read every ride logged so far. Move it aside first if you really");
  console.error("mean to start over — every existing .celog file becomes unreadable the moment it is gone.");
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("x25519");

writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));

console.log(`Private key → ${privateKeyPath}   (mode 0600, gitignored — BACK THIS UP)`);
console.log(`Public key  → ${publicKeyPath}`);
console.log("");
console.log("Next:");
console.log("  1. Copy the private key into your password manager, then verify you can paste it back.");
console.log("  2. Put the PUBLIC key on the Pi (it is safe to commit, and safe on a stolen bike):");
console.log("       scp ride-log-key.public.pem pi@cool-eva.local:/home/pi/cool-eva/");
console.log("  3. Restart the service. It will log `ride-log: encrypting to …` when it picks the key up.");
console.log("");
console.log("The Pi never sees the private key, so from then on it can append history it cannot read back.");
