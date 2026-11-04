import assert from "node:assert/strict";
import { evaluateOnPage, type HeadlessPage } from "./headless-page.ts";
let minimumClearance = Infinity;

interface Layout {
  scroll: number;
  width: number;
  clearance: number;
  header: number;
  tabs: number;
  padding: number;
  flush: number;
  overflow: string[];
  smallTargets: string[];
  hiddenOverflow: boolean;
  textOutside: string[];
}

export async function assertFixedLayout(page: HeadlessPage) {
  const result = (await evaluateOnPage(
    page,
    `(() => {
    const view = document.querySelector('.riding-view');
    const header = document.querySelector('.header').getBoundingClientRect();
    const tabs = document.querySelector('.tabs').getBoundingClientRect();
    const boxes = [...view.querySelectorAll('.tile,.value,.sub,.label,.ride-speed,.ride-soc,.range-margin-number,.range-share,button'), ...document.querySelectorAll('.header-notice:not([hidden]),.header .status')];
    const textOutside = [...view.querySelectorAll('.value,.label,.sub,.ride-speed,.ride-soc,.range-margin-number,.range-share')].filter(element => {
      const range=document.createRange(); range.selectNodeContents(element);
      const text=range.getBoundingClientRect(); const card=element.closest('.tile').getBoundingClientRect();
      return text.width>0 && (text.left<card.left || text.right>card.right || text.top<card.top || text.bottom>card.bottom);
    }).map(element => element.className);
    return {
      textOutside,
      scroll:document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight,
      width:document.body.scrollWidth,
      clearance:tabs.top-view.getBoundingClientRect().bottom,
      header:header.height-parseFloat(getComputedStyle(document.querySelector('.header')).paddingTop),
      tabs:tabs.height, padding:parseFloat(getComputedStyle(document.body).paddingBottom),
      flush:view.getBoundingClientRect().top-header.bottom,
      overflow:boxes.filter(element => element.scrollWidth>element.clientWidth+1 || (element.classList.contains('tile') && element.scrollHeight>element.clientHeight+1) || getComputedStyle(element).textOverflow==='ellipsis').map(element => element.className+': '+element.textContent),
      smallTargets:[...document.querySelectorAll('.header button,.tabs button,.sub-tabs button')].filter(element => !element.hidden && (element.getBoundingClientRect().width<44 || element.getBoundingClientRect().height<44)).map(element => element.textContent),
      hiddenOverflow:[view,document.body,document.documentElement,...view.querySelectorAll('.tile,.value,.label,.sub,[data-signal],[data-reading],.range-margin-number,.range-share')].some(element => ['hidden','clip'].includes(getComputedStyle(element).overflowY))
    };
  })()`
  )) as Layout;
  assert.equal(result.scroll, 0, `A riding view must not scroll: ${JSON.stringify(result)}`);
  assert.equal(result.width, 390);
  assert.ok(result.clearance >= 12, `At least 12 px of real riding clearance is required: ${JSON.stringify(result)}`);
  minimumClearance = Math.min(minimumClearance, result.clearance);
  assert.equal(result.header, 52);
  assert.equal(result.tabs, 84);
  assert.equal(result.padding, 84);
  assert.equal(result.flush, 0);
  assert.deepEqual(result.textOutside, [], "Full reading text must remain inside its card.");
  assert.deepEqual(result.overflow, [], "Text, charts and notices must fit internally without ellipsizing.");
  assert.deepEqual(result.smallTargets, [], "Every visible target must remain at least 44×44.");
  assert.equal(result.hiddenOverflow, false, "Hiding overflow is not a layout fix.");
}

export function resetLayoutClearance() {
  minimumClearance = Infinity;
}
export function layoutClearance() {
  return minimumClearance;
}
