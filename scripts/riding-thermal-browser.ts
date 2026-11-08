import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkRideThermalBrowser(page: HeadlessPage, file: string, theme: string) {
  await openPreview(page, file, "#ride", `thermal-${theme}`);
  await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
  await waitOnPage(
    page,
    "!!document.querySelector('[data-heat-fraction]') && document.querySelector('[data-heat-fraction]').dataset.heatFraction!=='unknown'",
    "sampled heat comparison"
  );
  const normal = (await evaluateOnPage(
    page,
    "Number(document.querySelector('[data-heat-fraction]').dataset.heatFraction)"
  )) as number;
  assert.ok(Math.abs(normal - 1473.9884 / 4427.791666666667) < 1e-12);
  for (const [values, side] of [
    [[2, 3, 4], "above"],
    [[-2, -3, -4], "below"],
    [[-2, 0, 3], "both"],
    [[0, 0, 0], "zero"],
  ] as const) {
    const plot = (await evaluateOnPage(
      page,
      `(() => {
      const svg=ridingPreview('lib/zero-sparkline.js').zeroSparkline(${JSON.stringify(values)},'var(--good)');
      const zero=Number(svg.querySelector('[data-zero-line]').getAttribute('y1'));
      return {zero,label:svg.querySelector('text').textContent,points:svg.querySelector('polyline').getAttribute('points').split(' ').map(point=>Number(point.split(',')[1]))};
    })()`
    )) as { zero: number; label: string; points: number[] };
    assert.equal(plot.label, "0");
    assert.ok(plot.zero >= 4 && plot.zero <= 44, "The labelled zero remains inside the 48px plot.");
    assert.ok(plot.points.every(point => point >= 4 && point <= 44));
    if (side === "above") {
      assert.ok(plot.points.every(point => point < plot.zero));
    } else if (side === "below") {
      assert.ok(plot.points.every(point => point > plot.zero));
    } else if (side === "both") {
      assert.ok(plot.points.some(point => point < plot.zero) && plot.points.some(point => point > plot.zero));
    } else {
      assert.ok(
        plot.points.every(point => point === plot.zero),
        "A flat zero trace is genuine zero."
      );
    }
  }
  assert.equal(
    await evaluateOnPage(
      page,
      "[[],[4.7]].every(values=>!ridingPreview('lib/zero-sparkline.js').zeroSparkline(values,'var(--good)').querySelector('polyline'))"
    ),
    true,
    "An empty history or one sample cannot invent a trend."
  );
  await evaluateOnPage(
    page,
    "pushPatch({coolant_out:[35,'°C','coolant']});ridingPreview('lib/store.js').chartTick.val++"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-reading=coolant-delta]').textContent"),
    "-1.50°C"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-reading=loop-removal]').textContent"),
    "-1.41"
  );
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-heat-fraction]').dataset.heatFraction"), "1");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.ride-heat-meter span').style.background"),
    "var(--bad)"
  );
  await evaluateOnPage(
    page,
    `(() => {
    const config=ridingPreview('lib/settings.js').settings;
    config.val={...config.val,active:{...config.val.active,coolantProbesEnabled:false}};
    ridingPreview('lib/store.js').chartTick.val++;
  })()`
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.querySelector('.ride-delta').hidden"), true);
  assert.equal(await evaluateOnPage(page, "document.querySelector('[data-reading=loop-removal]').textContent"), "—");
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-reading=resistance-heat]').textContent"),
    "1.47"
  );
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('[data-heat-fraction]').dataset.heatFraction"),
    "unknown"
  );
}
