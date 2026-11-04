// @ts-check

/** @typedef {{ privatePem: string, publicPem: string, fingerprint: string }} LogKeyPair */

/** @returns {Promise<LogKeyPair>} */
export async function generateLogKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const privateDer = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const publicDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  const fingerprint = new Uint8Array(await crypto.subtle.digest("SHA-256", publicDer));
  return {
    privatePem: encodePem(privateDer, "PRIVATE KEY"),
    publicPem: encodePem(publicDer, "PUBLIC KEY"),
    fingerprint: Array.from(fingerprint, byte => byte.toString(16).padStart(2, "0")).join(""),
  };
}

/** @param {ArrayBuffer} bytes @param {string} label */
function encodePem(bytes, label) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const lines = base64.match(/.{1,64}/g);
  if (lines === null) {
    throw new Error("The browser exported an empty key.");
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
