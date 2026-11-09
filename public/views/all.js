// @ts-check
import { ServiceMode } from "./service-mode.js";

// Existing #all bookmarks open the same Service page with its signal list expanded.
export function AllView() {
  return ServiceMode(true);
}
