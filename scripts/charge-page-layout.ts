import assert from "node:assert/strict";
import { evaluateOnPage, type HeadlessPage } from "./headless-page.ts";
import { FRAME } from "./riding-preview-page.ts";

export async function assertChargeLayout(page: HeadlessPage) {
  const original = await evaluateOnPage(page, "scrollY");
  await evaluateOnPage(page, "scrollTo(0,document.scrollingElement.scrollHeight)");
  await evaluateOnPage(page, FRAME);
  const result = await evaluateOnPage(
    page,
    `(()=>{
    const view=document.querySelector('.charge-view');
    const visible=element=>element.getBoundingClientRect().height>0&&element.getBoundingClientRect().width>0&&getComputedStyle(element).visibility==='visible';
    const boxes=[...view.querySelectorAll('.tile,.value,.charge-sub,.charge-label,input,button')].filter(visible);
    const header=document.querySelector('.header').getBoundingClientRect();
    const tabs=document.querySelector('.tabs').getBoundingClientRect();
    return {width:innerWidth,bodyWidth:document.body.scrollWidth,header:header.height-parseFloat(getComputedStyle(document.querySelector('.header')).paddingTop),tabs:tabs.height,tabBottom:tabs.bottom,height:innerHeight,clearance:tabs.top-Math.max(...boxes.map(element=>element.getBoundingClientRect().bottom)),nav:document.querySelectorAll('.tabs a').length,switches:view.querySelectorAll('.sub-tabs').length,small:[...view.querySelectorAll('button,input')].filter(visible).filter(element=>element.getBoundingClientRect().height<44||element.getBoundingClientRect().width<44).map(element=>element.outerHTML),overflow:boxes.filter(element=>element.scrollWidth>element.clientWidth+1||(element.classList.contains('tile')&&element.scrollHeight>element.clientHeight+1)||getComputedStyle(element).textOverflow==='ellipsis').map(element=>element.className),clipped:boxes.filter(element=>element.tagName!=='INPUT'&&['hidden','clip'].includes(getComputedStyle(element).overflowY)).map(element=>element.className)};
  })()`
  );
  assert.deepEqual(result, {
    width: 390,
    bodyWidth: 390,
    header: 52,
    tabs: 84,
    tabBottom: (result as { height: number }).height,
    height: (result as { height: number }).height,
    clearance: (result as { clearance: number }).clearance,
    nav: 5,
    switches: 0,
    small: [],
    overflow: [],
    clipped: [],
  });
  assert.ok(
    (result as { clearance: number }).clearance >= 11.5,
    `The last control clears the persistent navigation after scrolling: ${JSON.stringify(result)}`
  );
  await evaluateOnPage(page, `scrollTo(0,${original})`);
}
