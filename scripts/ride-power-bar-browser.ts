import assert from "node:assert/strict";
import { evaluateOnPage, type HeadlessPage } from "./headless-page.ts";

export async function assertPowerBar(page: HeadlessPage, ticks: number, unknown: number) {
  const result = (await evaluateOnPage(
    page,
    `(() => {
    const edge=document.querySelector('.power-edge');
    const box=edge.getBoundingClientRect();
    const card=edge.closest('.tile').getBoundingClientRect();
    const clip=edge.querySelector('clipPath rect');
    const references=[...edge.querySelectorAll('[data-layer=zero-reference]')];
    const ceilings=[...edge.querySelectorAll('[data-layer=ceiling]')];
    const dashes=[...edge.querySelectorAll('[data-layer=locked],[data-layer=unknown]')];
    return {
      charging:edge.dataset.charging==='true',height:box.height,insets:[box.left-card.left,card.right-box.right],
      visible:getComputedStyle(edge).visibility,ariaHidden:edge.getAttribute('aria-hidden'),
      clip:[clip.getAttribute('y'),clip.getAttribute('height'),clip.getAttribute('rx')],
      rectangles:[...edge.querySelectorAll('[data-layer=base],[data-layer=measured],[data-layer=excess]')].map(mark=>[mark.getAttribute('y'),mark.getAttribute('height')]),
      reference:references.map(mark=>[mark.getAttribute('x1'),mark.getAttribute('y1'),mark.getAttribute('y2'),mark.getAttribute('stroke-width'),mark.style.stroke]),
      ticks:ceilings.length,unknown:edge.querySelectorAll('[data-layer=unknown]').length,
      ceilingGeometry:ceilings.every(mark=>mark.getAttribute('y1')==='3'&&mark.getAttribute('y2')==='21'&&mark.getAttribute('stroke-width')==='2'&&mark.style.stroke==='var(--fg)'&&!mark.closest('.power-band')),
      dashGeometry:dashes.every(mark=>mark.getAttribute('y1')==='12'&&mark.getAttribute('y2')==='12'&&mark.getAttribute('stroke-width')==='2'&&mark.getAttribute('stroke-dasharray')==='4 4'&&mark.style.stroke==='var(--sub)'&&mark.closest('.power-band')),
      layers:[...edge.querySelectorAll('[data-layer]')].map(mark=>mark.dataset.layer),accessible:edge.getAttribute('aria-label')
    };
  })()`
  )) as {
    charging: boolean;
    height: number;
    insets: number[];
    visible: string;
    ariaHidden: string;
    clip: string[];
    rectangles: string[][];
    reference: string[][];
    ticks: number;
    unknown: number;
    ceilingGeometry: boolean;
    dashGeometry: boolean;
    layers: string[];
    accessible: string;
  };
  assert.equal(result.height, 24);
  assert.deepEqual(result.insets, [13, 13], "The bar is inset by the shared card padding plus border.");
  assert.deepEqual(result.clip, ["6", "12", "6"]);
  for (const rectangle of result.rectangles) {
    assert.deepEqual(rectangle, ["6", "12"]);
  }
  assert.deepEqual(
    result.reference,
    [
      [`${(36 / 166) * 100}%`, "1", "5", "1", "var(--sub)"],
      [`${(36 / 166) * 100}%`, "19", "23", "1", "var(--sub)"],
    ],
    "Both short zero marks share the fixed 36/166 origin."
  );
  assert.equal(result.ticks, ticks, "Only known ceilings receive a tick.");
  assert.equal(result.unknown, unknown, "An unknown side must retain its dashed neutral reference.");
  assert.equal(result.ceilingGeometry, true, "Fresh ceilings project beyond the rounded band.");
  assert.equal(result.dashGeometry, true, "Locked stretches are the approved dashed centreline.");
  assert.equal(result.layers[0], "base");
  assert.equal(
    result.layers.slice(-ticks || result.layers.length).every(layer => layer === "ceiling"),
    true,
    "The ceiling ticks paint last."
  );
  assert.equal(result.visible, result.charging ? "hidden" : "visible");
  assert.equal(result.ariaHidden, String(result.charging));
  assert.ok(result.accessible.includes(result.charging ? "inactive" : "36 kW regen, 130 kW drive"));
}
