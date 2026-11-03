import { createPublicKey, type KeyObject } from "crypto";

export function parseRideLogPublicKey(contents: string): ParsedRideLogKey {
  let publicKey: KeyObject;
  try {
    // OpenSSL accepts a BOM, whitespace and text before the PEM armour; keep that compatibility.
    publicKey = createPublicKey(contents);
  } catch (error) {
    throw new Error("Recording needs a valid X25519 public key.", { cause: error });
  }
  if (publicKey.asymmetricKeyType !== "x25519") {
    throw new Error(`ride-log: expected an X25519 public key, got ${publicKey.asymmetricKeyType}`);
  }
  const reason = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(contents) ? "private-key-on-pi" : null;
  return { publicKey, reason };
}

export interface ParsedRideLogKey {
  publicKey: KeyObject;
  reason: "private-key-on-pi" | null;
}
