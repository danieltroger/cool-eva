import { createPublicKey, type KeyObject } from "crypto";

export function parseRideLogPublicKey(contents: string): KeyObject {
  if (contents.length > 16 * 1024 || contents.includes("PRIVATE KEY")) {
    throw new Error("Recording needs an X25519 public key, not a private key.");
  }
  let publicKey: KeyObject;
  try {
    // OpenSSL accepts a BOM, whitespace and text before the PEM armour; keep that compatibility.
    publicKey = createPublicKey(contents);
  } catch {
    throw new Error("Recording needs a valid X25519 public key.");
  }
  if (publicKey.asymmetricKeyType !== "x25519") {
    throw new Error(`ride-log: expected an X25519 public key, got ${publicKey.asymmetricKeyType}`);
  }
  return publicKey;
}
