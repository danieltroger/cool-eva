import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { openPreview, FRAME } from "./riding-preview-page.ts";

export async function checkPersistentNavigation(page: HeadlessPage, file: string) {
  for (const theme of ["dark", "light"]) {
    await openPreview(page, file, "#more", `navigation-${theme}`);
    await evaluateOnPage(page, `ridingPreview('lib/theme.js').themePreference.val=${JSON.stringify(theme)}`);
    await evaluateOnPage(page, FRAME);
    await assertNavigation(page, "Settings");
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.fault-badge').textContent"),
      "3",
      "The tab badge reports the complete active count."
    );
    const historyLength = await evaluateOnPage(page, "history.length");
    await evaluateOnPage(page, "document.querySelector('[data-more=settings]').click()");
    assert.equal(
      await evaluateOnPage(page, "history.length"),
      historyLength,
      "Re-selecting the Settings root is a no-op."
    );
    await evaluateOnPage(page, "document.querySelector('.tabs').style.display='none'");
    await assert.rejects(assertNavigation(page, "Settings"), /Bottom navigation must remain visible/);
    await evaluateOnPage(page, "document.querySelector('.tabs').style.display=''");
    for (const [section, label] of [
      ["bike", "Bike"],
      ["service", "Service"],
      ["settings", "Settings"],
    ]) {
      await evaluateOnPage(
        page,
        `ridingPreview('lib/arming.js').arm('charge-stop');document.querySelector('[data-more=${section}]').click()`
      );
      await evaluateOnPage(page, FRAME);
      await assertNavigation(page, label);
      if (section === "service") {
        assert.equal(
          await evaluateOnPage(page, "document.querySelector('.all-signals > summary').textContent"),
          "Current CAN values"
        );
        assert.equal(
          await evaluateOnPage(page, "document.querySelector('.all-signals').open"),
          false,
          "Current CAN values is an inline browsable row inside Service."
        );
      }
      assert.equal(await evaluateOnPage(page, "ridingPreview('lib/arming.js').armed.rawVal"), "");
      await evaluateOnPage(page, "window.scrollTo(0,document.scrollingElement.scrollHeight)");
      await evaluateOnPage(page, FRAME);
      await assertNavigation(page, label);
      await evaluateOnPage(page, "window.scrollTo(0,0)");
    }
    await evaluateOnPage(page, "document.querySelector('[data-more=bike]').click()");
    await evaluateOnPage(page, FRAME);
    await assertNavigation(page, "Bike");
    await evaluateOnPage(page, "document.querySelector('.tabs a[href$=\"#charge\"]').click()");
    await waitOnPage(
      page,
      "!!document.querySelector('.charge-view')&&!location.search.includes('panel=')",
      "Charge from Bike"
    );
    await evaluateOnPage(page, "history.back()");
    await waitOnPage(
      page,
      "ridingPreview('lib/destination.js').destination.val==='bike-information'",
      "Back restores Bike"
    );
    await evaluateOnPage(page, FRAME);
    await assertNavigation(page, "Bike");
    await evaluateOnPage(page, "history.forward()");
    await waitOnPage(
      page,
      "!!document.querySelector('.charge-view')&&!location.search.includes('panel=')",
      "Forward restores Charge"
    );
  }
  console.log(
    "  ✓ persistent navigation: five real links on every More section, both themes, scrolling, Back/Forward, clean destination exits and hidden-bar negative control"
  );
}

async function assertNavigation(page: HeadlessPage, section: string) {
  const result = (await evaluateOnPage(
    page,
    `(() => {
    const tabs=document.querySelector('.tabs');
    const links=[...tabs.querySelectorAll('a')];
    const rect=tabs.getBoundingClientRect();
    const header=document.querySelector('.header');
    return {
      visible:rect.width===390&&rect.height===84&&rect.top>=0&&rect.bottom===innerHeight&&getComputedStyle(tabs).display!=='none',
      labels:links.map(link=>link.querySelector(':scope > span:last-child').textContent),
      selected:links.filter(link=>link.getAttribute('aria-current')==='page').map(link=>link.textContent),
      section:document.querySelector('.header-switch [aria-current=page]')?.textContent,
      switches:[...document.querySelectorAll('.header-switch a')].map(link=>link.textContent),
      parent:document.querySelector('[data-header-title]').textContent,
      clean:links.every(link=>!new URL(link.href).searchParams.has('panel')&&!new URL(link.href).searchParams.has('section')),
      targets:[...links,...document.querySelectorAll('.header-switch a')].every(link=>link.getBoundingClientRect().height>=44&&link.getBoundingClientRect().width>=44),
      headerHeight:header.getBoundingClientRect().height-parseFloat(getComputedStyle(header).paddingTop),
      headerTop:header.getBoundingClientRect().top,
      width:innerWidth,bodyWidth:document.body.scrollWidth
    };
  })()`
  )) as {
    visible: boolean;
    labels: string[];
    selected: string[];
    section: string;
    switches: string[];
    parent: string;
    clean: boolean;
    targets: boolean;
    headerHeight: number;
    headerTop: number;
    width: number;
    bodyWidth: number;
  };
  assert.equal(result.visible, true, "Bottom navigation must remain visible on every destination.");
  assert.deepEqual(result.labels, ["Ride", "Range", "Charge", "Faults", "More"]);
  assert.deepEqual(result.selected, ["More"]);
  assert.equal(result.section, section);
  assert.deepEqual(result.switches, ["Settings", "Bike", "Service"]);
  assert.equal(result.parent, "More");
  assert.equal(result.clean, true, "Every bottom link must leave both destination query parameters behind.");
  assert.equal(result.targets, true);
  assert.equal(result.headerHeight, 52);
  assert.equal(result.headerTop, 0);
  assert.equal(result.width, 390);
  assert.equal(result.bodyWidth, 390);
}
