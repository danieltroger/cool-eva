// @ts-check

/** Generates the stable shared key that onboarding persists once, never at every boot. */
export function generateBleSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** @param {unknown} secret */
export function validBleSecret(secret) {
  return typeof secret === "string" && /^[0-9a-f]{64}$/.test(secret);
}

/** @param {string} secret */
export function normalizeBleSecret(secret) {
  const normalized = secret.trim().toLowerCase();
  if (!validBleSecret(normalized)) {
    throw new Error("Paste the generated 64-character Bluetooth key from the Pi.");
  }
  return normalized;
}
