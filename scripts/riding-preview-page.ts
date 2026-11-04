import { evaluateOnPage, gotoPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
export const FRAME = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

export async function openPreview(page: HeadlessPage, file: string, hash: string, testCase: string, extra = "") {
  await gotoPage(page, `file://${file}?scene=riding&fixture=all-installed&case=${testCase}${extra}${hash}`);
  await waitOnPage(
    page,
    "document.documentElement.dataset.previewReady === 'yes' && document.querySelector('.view')",
    "the actual dashboard view"
  );
  await evaluateOnPage(page, FRAME);
}
