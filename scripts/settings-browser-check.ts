import { evaluateOnPage, type HeadlessPage } from "./headless-page.ts";
import { checkSettingsBatchBrowser } from "./settings-batch-browser.ts";
import { checkSettingsCleanupBrowser } from "./settings-cleanup-browser.ts";

export async function checkSettingsBrowser(page: HeadlessPage, previewFile: string): Promise<void> {
  await checkSettingsBatchBrowser(page, previewFile);
  await evaluateOnPage(page, "ridingPreview('lib/units.js').setUnitSystem('metric')");
  await checkSettingsCleanupBrowser(page, previewFile);
}
