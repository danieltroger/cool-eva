// @ts-check

/** @param {unknown} password */
export function validNetworkPassword(password) {
  return typeof password === "string" && (/^[\x20-\x7e]{8,63}$/.test(password) || /^[0-9a-f]{64}$/i.test(password));
}
