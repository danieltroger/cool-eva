// @ts-check
import van from "../vendor/van-1.6.1.js";
import { readPhoneValue, writePhoneValue } from "./phone-storage.js";
import { settings } from "./settings.js";

const dismissed = van.state("");

export function setupNoticePending() {
  const current = settings.val;
  return (
    !!current?.instanceId &&
    current.source === "legacy" &&
    !setupNoticeDismissed(`cool-eva.setup-seen:${current.instanceId}`)
  );
}

/** @param {string} key */
export function setupNoticeDismissed(key) {
  return dismissed.val === key || !!readPhoneValue(key);
}

/** @param {string} key */
export function dismissSetupNotice(key) {
  writePhoneValue(key, "1");
  dismissed.val = key;
}
