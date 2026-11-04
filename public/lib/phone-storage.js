// @ts-check

/** @param {string} key */
export function readPhoneValue(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn("settings: phone storage cannot be read", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}
/** @param {string} key @param {string} value */
export function writePhoneValue(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn("settings: phone storage cannot be written", error instanceof Error ? error.name : "unknown error");
    return false;
  }
}
