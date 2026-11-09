import type { HeadlessPage } from "./headless-page.ts";
import { checkFaultsCases } from "./riding-faults-browser.ts";
import { checkAllSignals } from "./service-browser.ts";
export { assertAllContent } from "./service-browser.ts";
export { assertFaultsContent, checkFaultNavigation as checkFaultReportNavigation } from "./riding-faults-browser.ts";

export async function checkFaultsAllCases(
  page: HeadlessPage,
  file: string,
  theme: string,
  capture?: (name: string) => Promise<void>
) {
  await checkFaultsCases(page, file, theme);
  await checkAllSignals(page, file, theme, capture);
}
