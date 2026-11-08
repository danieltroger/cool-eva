import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkFanCommands(page: HeadlessPage, file: string) {
  await openPreview(page, file, "#ride/cooling", "fan-command-order");
  await waitOnPage(page, "!document.querySelector('[data-fan-mode=manual]').disabled", "fan read on entry");
  assert.equal(await evaluateOnPage(page, "document.querySelector('.fan-slider').hidden"), true);
  assert.deepEqual(
    await evaluateOnPage(page, "[...document.querySelectorAll('.cooling-fan button')].map(button=>button.textContent)"),
    ["Auto", "Manual"]
  );
  await evaluateOnPage(
    page,
    `(() => {
    const originalFetch=window.fetch.bind(window);
    window.fanRequests=[];
    window.fanReleases=[];
    window.holdFanPosts=false;
    window.refuseFanPost=false;
    window.fanSlider=document.querySelector('.fan-slider');
    window.fetch=async(input,options={})=>{
      const url=new URL(String(input),location.href);
      if(url.pathname!=='/fan')return originalFetch(input,options);
      const method=options.method??'GET';
      window.fanRequests.push([method,url.searchParams.toString(),new Headers(options.headers).get('X-Cool-Eva')]);
      if(method==='POST'&&window.refuseFanPost){
        window.refuseFanPost=false;
        return new Response(JSON.stringify({...FAN,message:'Synthetic refusal'}),{status:503});
      }
      if(method==='POST'&&window.holdFanPosts)await new Promise(resolve=>window.fanReleases.push(resolve));
      return originalFetch(input,options);
    };
    document.querySelector('[data-fan-mode=manual]').click();
  })()`
  );
  await waitOnPage(
    page,
    "!document.querySelector('.fan-slider').hidden&&document.querySelector('[data-fan-status]').textContent==='Manual control'",
    "manual mode acknowledged"
  );
  const sliderStyle = (await evaluateOnPage(
    page,
    `(() => {
    const slider=document.querySelector('.fan-slider');
    const style=getComputedStyle(slider);
    return {accent:style.accentColor,selected:getComputedStyle(document.querySelector('[data-fan-mode=manual]')).color,appearance:style.appearance,height:slider.getBoundingClientRect().height};
  })()`
  )) as { accent: string; selected: string; appearance: string; height: number };
  assert.equal(sliderStyle.accent, sliderStyle.selected, "The slider uses the selected control's green ink.");
  assert.equal(
    sliderStyle.appearance,
    "auto",
    "The approved slider uses the native control, without the retired amber skin."
  );
  assert.equal(sliderStyle.height, 44);
  await evaluateOnPage(
    page,
    `(() => {
    window.holdFanPosts=true;
    const slider=document.querySelector('.fan-slider');
    slider.value='0';slider.dispatchEvent(new Event('input',{bubbles:true}));
  })()`
  );
  await waitOnPage(page, "window.fanRequests.length===2", "first duty passes the send interval");
  await evaluateOnPage(
    page,
    `(() => {
    const slider=document.querySelector('.fan-slider');
    for(const index of [1,46]){slider.value=String(index);slider.dispatchEvent(new Event('input',{bubbles:true}));}
  })()`
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.fan-slider').getAttribute('aria-valuetext')"),
    "75 %"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.fan-slider').max"),
    "71",
    "The slider has zero followed by the server's 30–100% stops."
  );
  assert.deepEqual(
    await evaluateOnPage(page, "window.fanRequests"),
    [
      ["POST", "mode=manual", "fan"],
      ["POST", "duty=0", "fan"],
    ],
    "One request is in flight; intermediate slider positions remain coalesced."
  );
  await evaluateOnPage(page, "window.fanReleases.shift()()");
  await waitOnPage(
    page,
    "window.fanRequests.length===3&&window.fanReleases.length===1",
    "latest duty sent after the older reply"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.fan-slider').getAttribute('aria-valuetext')"),
    "75 %",
    "The older duty-zero reply cannot overwrite the pending 75% thumb."
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.fan-slider')===window.fanSlider"),
    true,
    "The input stays mounted throughout a drag and its replies."
  );
  await evaluateOnPage(page, "window.holdFanPosts=false;window.fanReleases.shift()()");
  await waitOnPage(
    page,
    "document.querySelector('[data-signal=fan_target_pct]').textContent==='75'",
    "latest duty confirmed"
  );
  await evaluateOnPage(page, "document.querySelector('[data-fan-mode=automatic]').click()");
  await waitOnPage(
    page,
    "window.fanRequests.length===4&&FAN.mode==='automatic'&&document.querySelector('.fan-slider').hidden&&document.querySelector('[data-fan-status]').textContent==='Automatic control'",
    "automatic mode restored"
  );
  assert.deepEqual(await evaluateOnPage(page, "window.fanRequests"), [
    ["POST", "mode=manual", "fan"],
    ["POST", "duty=0", "fan"],
    ["POST", "duty=75", "fan"],
    ["POST", "mode=auto", "fan"],
  ]);
  await evaluateOnPage(page, "window.refuseFanPost=true;document.querySelector('[data-fan-mode=manual]').click()");
  await waitOnPage(
    page,
    "document.querySelector('[data-fan-status]').textContent==='Fan status unavailable'",
    "a refused command remains uncertain"
  );
  await evaluateOnPage(page, "ridingPreview('lib/fan-control.js').refreshFanStatus()");
  await waitOnPage(
    page,
    "document.querySelector('[data-fan-status]').textContent==='Automatic control'",
    "a confirmed read recovers command uncertainty"
  );
  assert.deepEqual(await evaluateOnPage(page, "window.fanRequests.at(-1)"), ["GET", "", null]);
}
