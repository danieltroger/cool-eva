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

export async function assertFixedLayout(page: HeadlessPage, parkedContentBelow = false) {
  const result = (await evaluateOnPage(
    page,
    `(() => {
    const view = document.querySelector('.riding-view');
    const header = document.querySelector('.header').getBoundingClientRect();
    const tabs = document.querySelector('.tabs').getBoundingClientRect();
    const boxes = [...view.querySelectorAll('.tile,.value,.sub,.label,.ride-speed,.ride-soc,.range-margin-number,.range-share,.charge-soc-number,.charge-ceiling,.charge-ac-reading,.charge-graph-footer,.fault-preview-name,button'), ...document.querySelectorAll('.header a,.app-title')];
    const textOutside = [...view.querySelectorAll('.value,.label,.sub,.ride-speed,.ride-soc,.range-margin-number,.range-share,.charge-soc-number,.charge-ceiling,.charge-ac-reading,.charge-graph-footer,.fault-preview-name')].filter(element => {
      const range=document.createRange(); range.selectNodeContents(element);
      const text=range.getBoundingClientRect(); const card=(element.closest('.tile')??view).getBoundingClientRect();
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
      overflow:boxes.filter(element => element.scrollWidth>element.clientWidth+1 || ((element.classList.contains('tile') || element.tagName==='BUTTON') && element.scrollHeight>element.clientHeight+1) || getComputedStyle(element).textOverflow==='ellipsis').map(element => element.className+': '+element.textContent),
      smallTargets:[...document.querySelectorAll('.header a,.tabs a,.sub-tabs button,.riding-view button')].filter(element => !element.hidden && (element.getBoundingClientRect().width<44 || element.getBoundingClientRect().height<44)).map(element => element.textContent),
      hiddenOverflow:[view,document.body,document.documentElement,...view.querySelectorAll('.tile,.value,.label,.sub,[data-signal],[data-reading],.range-margin-number,.range-share,.charge-soc-number,.charge-ceiling,.charge-ac-reading,.charge-graph-footer,.fault-preview-name')].some(element => ['hidden','clip'].includes(getComputedStyle(element).overflowY))
    };
  })()`
  )) as Layout;
  if (!parkedContentBelow) {
    assert.equal(result.scroll, 0, `A riding view must not scroll: ${JSON.stringify(result)}`);
  }
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

export async function assertRendered(page: HeadlessPage, selectors: string[]) {
  const missing = await evaluateOnPage(
    page,
    `(()=>{const selectors=${JSON.stringify(selectors)};return selectors.flatMap(selector=>{const elements=[...document.querySelectorAll(selector)];if(!elements.length)return [selector+': absent'];return elements.filter(element=>{const box=element.getBoundingClientRect();if(box.width<=0||box.height<=0)return true;for(let parent=element;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0||style.textOverflow==='ellipsis')return true;}return false;}).map(()=>selector+': hidden');});})()`
  );
  assert.deepEqual(missing, [], "Every required reading/control must render; hidden tiles cannot buy a short view.");
}
