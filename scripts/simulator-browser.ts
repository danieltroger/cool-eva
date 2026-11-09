import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTES } from "../public/lib/router.js";
import { SIMULATOR_MESSAGE } from "../src/replay/http.ts";
import { writeSimulatorCapture } from "./simulator-fixture.ts";
import { runSimulator, type SimulatorPass } from "./simulate.ts";
import {
  evaluateOnPage,
  gotoPage,
  waitOnPage,
  screenshotPage,
  reloadPage,
  type HeadlessPage,
} from "./headless-page.ts";

export async function checkSimulatorBrowser(page: HeadlessPage, shots?: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-simulator-browser-"));
  const path = join(directory, "synthetic.log");
  await writeSimulatorCapture(path, 180_000);
  if (shots) await mkdir(shots, { recursive: true });
  const cancellation = new AbortController();
  let release: (pass: SimulatorPass) => void = () => {};
  const ready = new Promise<SimulatorPass>(resolve => {
    release = resolve;
  });
  let output = "";
  const running = runSimulator({
    path,
    port: 0,
    signal: cancellation.signal,
    onReady: async pass => {
      release(pass);
    },
    onOutput: text => {
      output += text;
    },
  });
  try {
    const pass = await Promise.race([
      ready,
      running.then(() => {
        throw new Error("Simulator stopped before ready");
      }),
    ]);
    const base = `http://127.0.0.1:${pass.port}`;
    for (const theme of ["dark", "light"]) {
      await gotoPage(page, base);
      await evaluateOnPage(page, `localStorage.setItem('coolEva.theme',${JSON.stringify(theme)})`);
      await gotoPage(page, base + "/#ride");
      await evaluateOnPage(
        page,
        `(async()=>{(await import('/lib/theme.js')).themePreference.val=${JSON.stringify(theme)}})()`
      );
      await installObservation(page);
      assert.equal(await evaluateOnPage(page, "innerWidth"), 390);
      await waitOnPage(page, `document.documentElement.dataset.theme===${JSON.stringify(theme)}`, "simulator theme");
      for (const route of ROUTES) {
        await evaluateOnPage(page, `simDestination.openRidingView(${JSON.stringify(route.name)})`);
        await waitOnPage(page, `location.hash===${JSON.stringify(route.hash)}`, route.label);
        assert.equal(
          await evaluateOnPage(page, "document.documentElement.scrollWidth<=390"),
          true,
          `${route.name} width`
        );
      }
      await checkActions(page, theme, shots);
      assert.deepEqual(await evaluateOnPage(page, "simErrors"), [], "No renderer errors from shaped 403s");
      assert.equal(await evaluateOnPage(page, "simReload.pageReloadRequired.rawVal"), false);
      await reloadPage(page);
      await waitOnPage(page, "document.readyState==='complete'", "direct simulator page reload");
      await installObservation(page);
    }
  } catch (error) {
    console.error(output);
    console.error(
      await evaluateOnPage(
        page,
        "JSON.stringify({url:location.href,buttons:[...document.querySelectorAll('button')].map(node=>({text:node.textContent,disabled:node.disabled})),body:document.body.innerText.slice(0,2000)})"
      )
    );
    throw error;
  } finally {
    cancellation.abort();
    await running;
    await rm(directory, { recursive: true, force: true });
  }
  await checkDraftAcrossLoop(page);
  console.log(
    "  ✓ simulator browser: every route, visible refusal controls, automatic parameter reads and honest Service write refusals, actual 403s, both themes and stable Settings draft across restart"
  );
}

async function installObservation(page: HeadlessPage): Promise<void> {
  await evaluateOnPage(
    page,
    `(async()=>{
    window.simDestination=await import('/lib/destination.js');
    window.simSettings=await import('/lib/settings.js');
    window.simArming=await import('/lib/arming.js');
    window.simStore=await import('/lib/store.js');
    window.simReload=await import('/lib/page-reload.js');
    window.simRequests=[];window.simErrors=[];
    const originalFetch=window.fetch;
    window.fetch=async(...args)=>{
      const response=await originalFetch(...args);
      if(args[1]?.method&&!['GET','HEAD'].includes(args[1].method)){
        const payload=await response.clone().json();
        simRequests.push({path:new URL(String(args[0]),location.href).pathname,status:response.status,payload});
      }
      return response;
    };
    const originalError=console.error;
    console.error=(...args)=>{simErrors.push(args.map(String).join(' '));originalError(...args)};
  })()`
  );
  await waitOnPage(
    page,
    "simStore.connection.rawVal==='live'&&simSettings.settingsConfirmed.rawVal",
    "real simulator connection/settings"
  );
}

async function destination(page: HeadlessPage, name: string, section = ""): Promise<void> {
  await evaluateOnPage(page, `simDestination.openDestination(${JSON.stringify(name)},${JSON.stringify(section)})`);
  await waitOnPage(page, "!!document.querySelector('.settings-page')", name);
}

async function button(page: HeadlessPage, text: string, arm = false, scope = "document"): Promise<void> {
  const expression = `(()=>{const found=[...${scope}.querySelectorAll('button')].find(node=>(node.textContent+" "+(node.closest('.owner-action')?.textContent??'')).includes(${JSON.stringify(text)}));return found&&!found.disabled})()`;
  await waitOnPage(page, expression, `button ${text}`);
  await evaluateOnPage(
    page,
    `window.simButton=[...${scope}.querySelectorAll('button')].find(node=>(node.textContent+" "+(node.closest('.owner-action')?.textContent??'')).includes(${JSON.stringify(text)}));simButton.click()`
  );
  if (arm) {
    await waitOnPage(page, "simArming.armed.rawVal!==''&&simArming.armDwellElapsed()", `arm ${text}`);
    await evaluateOnPage(
      page,
      "if(!simButton.isConnected)throw new Error('Armed control was replaced');simButton.click()"
    );
  }
}

async function refused(
  page: HeadlessPage,
  path: string,
  action: () => Promise<void>,
  name: string,
  theme: string,
  shots?: string,
  expected = SIMULATOR_MESSAGE
): Promise<void> {
  const count = await evaluateOnPage(
    page,
    `simRequests.filter(request=>request.path===${JSON.stringify(path)}).length`
  );
  await action();
  await waitOnPage(
    page,
    `simRequests.filter(request=>request.path===${JSON.stringify(path)}).length>${count}`,
    `POST reply ${name}`
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      `(()=>{const reply=simRequests.filter(request=>request.path===${JSON.stringify(path)}).at(-1);return [reply.status,reply.payload.message,reply.payload.csrfRefusal===undefined]})()`
    ),
    [403, SIMULATOR_MESSAGE, true]
  );
  await waitOnPage(page, `document.body.innerText.includes(${JSON.stringify(expected)})`, `rendered refusal ${name}`);
  assert.equal(
    await evaluateOnPage(
      page,
      "/Read undefined|Cannot read properties|could not reach the Pi/i.test(document.body.innerText)"
    ),
    false
  );
  if (shots) {
    await evaluateOnPage(
      page,
      `(()=>{const notes=[...document.querySelectorAll('.action-note,.settings-note,.fault-save-error')].filter(node=>node.textContent.includes(${JSON.stringify(expected)}));notes.at(-1)?.scrollIntoView({block:'center'})})()`
    );
    await screenshotPage(page, join(shots, `${theme}-${name}.png`));
  }
}

async function checkActions(page: HeadlessPage, theme: string, shots?: string): Promise<void> {
  await destination(page, "settings", "software");
  await refused(page, "/update", () => button(page, "Update", true), "update", theme, shots);
  await destination(page, "settings", "connections");
  await destination(page, "settings", "bike");
  await waitOnPage(page, "!!document.querySelector('select[aria-label=\"Coolant probes\"]')", "settings draft");
  await evaluateOnPage(
    page,
    `const input=document.querySelector('select[aria-label="Coolant probes"]');input.value='true';input.dispatchEvent(new Event('change',{bubbles:true}));input.closest('.settings-card').id='sim-save'`
  );
  await refused(
    page,
    "/settings",
    () => button(page, "Save", false, "document.querySelector('#sim-save')"),
    "settings-save",
    theme,
    shots
  );
  await refused(page, "/settings/apply", () => button(page, "Restart", true), "settings-apply", theme, shots);
  await destination(page, "advanced-service");
  await waitOnPage(
    page,
    "document.querySelectorAll('.parameter-browser [data-select-parameter]').length===277",
    "read-only Service catalogue in simulator"
  );
  await evaluateOnPage(page, "document.querySelector('.service-actions').open=true");
  await evaluateOnPage(page, "new Promise(resolve=>requestAnimationFrame(resolve))");
  await refused(page, "/vcu-write", () => button(page, "Restart bike", true), "service-write", theme, shots, "—");
  assert.equal(
    await evaluateOnPage(
      page,
      "document.querySelector('[data-service-action=reset-vcu]').closest('.layout-compact-stack').querySelector('[role=status]').title"
    ),
    SIMULATOR_MESSAGE
  );
  // Removed read controls retain HTTP coverage in check-simulator.ts; selection now reads automatically.
  await refused(
    page,
    "/vcu-probe",
    () =>
      evaluateOnPage(
        page,
        `(async()=>{const client=await import('/lib/service-client.js');const parameter=client.serviceCatalogue.rawVal.parameters.find(parameter=>parameter.name==='MAP3_PWR');await(await import('/lib/service-edits.js')).selectServiceParameter(parameter);})()`
      ).then(() => {}),
    "service-probe",
    theme,
    shots,
    "Read failed: disabled in simulator"
  );
  await waitOnPage(page, "!!document.querySelector('.parameter-editor')", "automatic selected parameter read");
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-editor button').disabled"), true);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.parameter-editor [role=status]').title"),
    SIMULATOR_MESSAGE
  );
  await destination(page, "bike-information");
  await refused(
    page,
    "/lifetime-read",
    () => button(page, "Read bike history", true),
    "lifetime-read",
    theme,
    shots,
    "—"
  );
  await evaluateOnPage(page, `simDestination.openRidingView('charge')`);
  await evaluateOnPage(
    page,
    `(async()=>{
    const writes=await import('/lib/charge-write.js');
    simStore.apply({type:'patch',ts:Date.now(),signals:{charge_manager_state:{value:35,unit:'',group:'charge',ts:Date.now()}}});
    writes.applyWriteStatus(await(await fetch('/vcu-write')).json());
  })()`
  );
  await refused(
    page,
    "/charge-auto",
    () => button(page, "Resume", false, "document.querySelector('.charge-auto-control')"),
    "charge-auto",
    theme,
    shots,
    "Unavailable"
  );
  assert.equal(
    await evaluateOnPage(
      page,
      `document.querySelector('.charge-auto-control [role=status]').title.includes(${JSON.stringify(SIMULATOR_MESSAGE)})`
    ),
    true,
    "The short Charge status retains the simulator's refusal reason in its tooltip."
  );
  await evaluateOnPage(
    page,
    `(async()=>{
    simDestination.openRidingView('faults');
    const faults=await import('/lib/expected-faults.js');
    const host=document.createElement('section');host.id='sim-expected';host.className='settings-card';host.append('Constructed fault for simulator refusal check',faults.ExpectedCheckbox('44/0','P0A07'));document.body.append(host);
  })()`
  );
  await refused(
    page,
    "/expected-faults",
    async () => {
      await evaluateOnPage(page, "document.querySelector('#sim-expected input').click()");
    },
    "expected-faults",
    theme,
    shots,
    "Expected change could not be confirmed."
  );
  await evaluateOnPage(page, "document.querySelector('#sim-expected').remove()");
  await destination(page, "bike-information");
  await evaluateOnPage(page, "(async()=>{window.simSheet=await import('/views/sheet.js')})()");
  await refused(
    page,
    "/waypoint",
    () => button(page, "Save waypoint", false, "document.querySelector('.settings-page')"),
    "waypoint",
    theme,
    shots
  );
  // Construct only the precondition; the real flush still reaches the simulator's 403.
  await evaluateOnPage(
    page,
    "simSheet.status.val={...simSheet.status.rawVal,log:{...simSheet.status.rawVal.log,enabled:true}} "
  );
  await refused(
    page,
    "/recording/flush",
    () => button(page, "Download all ride logs", false, "document.querySelector('.settings-page')"),
    "recording-flush",
    theme,
    shots,
    "failed: The current recording could not be sealed for download."
  );
}

async function checkDraftAcrossLoop(page: HeadlessPage): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-simulator-draft-"));
  const path = join(directory, "synthetic.log");
  await writeSimulatorCapture(path);
  const cancellation = new AbortController();
  let release: (pass: SimulatorPass) => void = () => {};
  const ready = new Promise<SimulatorPass>(resolve => {
    release = resolve;
  });
  const running = runSimulator({
    path,
    port: 0,
    signal: cancellation.signal,
    onReady: async pass => {
      release(pass);
    },
    onOutput: () => {},
  });
  try {
    const pass = await Promise.race([
      ready,
      running.then(() => {
        throw new Error("Draft simulator ended before ready");
      }),
    ]);
    await gotoPage(page, `http://127.0.0.1:${pass.port}`);
    await installObservation(page);
    await destination(page, "settings", "connections");
    await evaluateOnPage(page, "simSettings.editSetting('phoneHotspotSsid','Synthetic unsaved hotspot')");
    const before = (await evaluateOnPage(
      page,
      "({instanceId:simSettings.settings.rawVal.instanceId,generation:simSettings.settings.rawVal.processGeneration})"
    )) as { instanceId: string; generation: string };
    await waitOnPage(
      page,
      `simSettings.settingsConfirmed.rawVal&&simSettings.settings.rawVal.processGeneration!==${JSON.stringify(before.generation)}`,
      "real EOF restart and reconnect"
    );
    assert.equal(await evaluateOnPage(page, "simSettings.settings.rawVal.instanceId"), before.instanceId);
    assert.equal(
      await evaluateOnPage(page, "simSettings.settingDraft('phoneHotspotSsid','').rawVal"),
      "Synthetic unsaved hotspot"
    );
    assert.equal(await evaluateOnPage(page, "new URL(location.href).searchParams.get('section')"), "connections");
    await evaluateOnPage(page, "simDestination.openDestination('settings','bike');history.back()");
    await waitOnPage(page, "new URL(location.href).searchParams.get('section')==='connections'", "history return");
  } finally {
    cancellation.abort();
    await running;
    await rm(directory, { recursive: true, force: true });
  }
}
