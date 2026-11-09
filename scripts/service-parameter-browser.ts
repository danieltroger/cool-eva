import assert from "node:assert/strict";
import { evaluateOnPage, waitOnPage, type HeadlessPage } from "./headless-page.ts";
import { FRAME } from "./riding-preview-page.ts";

export async function checkServiceParameterBrowser(page: HeadlessPage) {
  await selectParameter(page, "MAP3_PWR", 57);
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "[document.querySelector('.parameter-facts').textContent,document.querySelector('.parameter-editor input').value,document.querySelector('.parameter-editor button').disabled]"
    ),
    ["Current 480 rawStock —", "480", true]
  );
  assert.deepEqual(
    await evaluateOnPage(
      page,
      "[getComputedStyle(document.querySelector('.parameter-editor input')).fontSize,getComputedStyle(document.querySelector('.parameter-facts')).fontSize]"
    ),
    ["16px", "14px"]
  );
  await editValue(page, "0.5");
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-editor button').disabled"), true);
  await editValue(page, "500");
  const firstTap = await evaluateOnPage(
    page,
    `(async()=>{
    const button=document.querySelector('.parameter-editor button');
    button.click();
    while(ridingPreview('lib/service-client.js').serviceBusy.rawVal) {await new Promise(requestAnimationFrame);}
    const dwell=ridingPreview('lib/arming.js').armDwellElapsed();
    button.click();
    return {dwell,writes:SERVICE_PARAMETER_REQUESTS.filter(request=>request.method==='POST'&&request.url.startsWith('/vcu-write')).length};
  })()`
  );
  assert.deepEqual(firstTap, { dwell: false, writes: 0 }, "Two immediate DOM clicks cannot write.");
  await waitOnPage(
    page,
    "ridingPreview('lib/arming.js').armed.rawVal==='parameter:57'&&ridingPreview('lib/arming.js').armDwellElapsed()",
    "real parameter dwell"
  );
  await evaluateOnPage(page, "document.querySelector('.parameter-editor button').click()");
  await waitOnPage(
    page,
    "document.querySelector('.parameter-editor [role=status]').textContent==='Bike confirmed. Restart bike to apply.'",
    "own parameter readback"
  );
  const write = await evaluateOnPage(
    page,
    "SERVICE_PARAMETER_REQUESTS.filter(request=>request.method==='POST'&&request.url.startsWith('/vcu-write')).map(request=>({query:Object.fromEntries(new URL(request.url,'http://fixture.invalid').searchParams),header:request.headers['X-Cool-Eva']}))"
  );
  assert.deepEqual(write, [
    {
      query: { action: "parameter", name: "MAP3_PWR", value: "500", expected: "480", list: "0" },
      header: "service-write",
    },
  ]);
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-facts strong').textContent"), "500 raw");
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-editor button').disabled"), true);
  await checkWriteFailures(page);
  await selectParameter(page, "VSM_CONFIG_1", 16);
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-editor button').disabled"), true);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.parameter-editor [role=status]').textContent"),
    "Read only"
  );
  await selectParameter(page, "TORQUE_LIMIT", 48);
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-facts strong').textContent"), "230.0 Nm");
  await editValue(page, "230.11");
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-editor button').disabled"), true);
  await checkBackup(page);
}

export async function selectParameter(page: HeadlessPage, name: string, index: number) {
  await evaluateOnPage(
    page,
    `(()=>{const input=document.querySelector('[name=parameter-search]');input.value=${JSON.stringify(name)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await evaluateOnPage(page, FRAME);
  await evaluateOnPage(page, `document.querySelector('.parameter-results [data-select-parameter="${index}"]').click()`);
  await waitOnPage(
    page,
    "!ridingPreview('lib/service-client.js').serviceBusy.rawVal&&!!document.querySelector('.parameter-editor')",
    "selected parameter read"
  );
  await evaluateOnPage(page, FRAME);
  assert.equal(await evaluateOnPage(page, "document.querySelector('.parameter-editor').dataset.parameter"), name);
}

async function editValue(page: HeadlessPage, value: string) {
  await evaluateOnPage(
    page,
    `(()=>{const input=document.querySelector('.parameter-editor input');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await evaluateOnPage(page, FRAME);
}

export async function confirmServiceButton(page: HeadlessPage, selector: string, key: string) {
  await evaluateOnPage(page, `document.querySelector(${JSON.stringify(selector)}).click()`);
  await waitOnPage(
    page,
    `ridingPreview('lib/arming.js').armed.rawVal===${JSON.stringify(key)}&&ridingPreview('lib/arming.js').armDwellElapsed()`,
    "fresh arm and real dwell"
  );
  await evaluateOnPage(page, `document.querySelector(${JSON.stringify(selector)}).click()`);
  await waitOnPage(page, "!ridingPreview('lib/service-client.js').serviceBusy.rawVal", "confirmed operation settles");
  await evaluateOnPage(page, FRAME);
}

async function checkWriteFailures(page: HeadlessPage) {
  for (const mode of ["lost", "refused", "mismatch", "missing"]) {
    await editValue(page, "550");
    await evaluateOnPage(
      page,
      `(()=>{
      window.serviceUnmodifiedFetch=window.fetch;
      window.fetch=async(input,options={})=>{
        const url=new URL(String(input),'http://fixture.invalid');
        if(url.pathname==='/vcu-write'&&options.method==='POST'&&url.searchParams.get('action')==='parameter') {
          const response=await serviceUnmodifiedFetch(input,options);
          if(${JSON.stringify(mode)}==='lost') {throw new Error('Synthetic response lost after delivery');}
          const payload=await response.json();
          if(${JSON.stringify(mode)}==='refused') {payload.result=null;payload.message='Synthetic refusal';}
          if(${JSON.stringify(mode)}==='mismatch') {payload.result.onBike.value+=1;}
          if(${JSON.stringify(mode)}==='missing') {payload.result.onBike=null;}
          return new Response(JSON.stringify(payload),{status:${JSON.stringify(mode)}==='refused'?409:200,headers:{'Content-Type':'application/json'}});
        }
        return serviceUnmodifiedFetch(input,options);
      };
    })()`
    );
    await confirmServiceButton(page, ".parameter-editor button", "parameter:57");
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.parameter-editor [role=status]').textContent"),
      "—",
      `${mode} cannot retain an earlier confirmed outcome.`
    );
    assert.equal(
      await evaluateOnPage(page, "document.querySelector('.parameter-editor [role=status]').classList.contains('bad')"),
      true
    );
    if (mode !== "mismatch") {
      assert.equal(
        await evaluateOnPage(page, "document.querySelector('.parameter-facts strong').textContent"),
        "—",
        "Unverified delivery cannot revive an old snapshot value."
      );
    }
    await evaluateOnPage(page, "window.fetch=serviceUnmodifiedFetch;SERVICE_PARAMETERS.probes['57'].value=500");
    await selectParameter(page, "MAP3_PWR", 57);
  }
}

async function checkBackup(page: HeadlessPage) {
  const before = await parameterWriteCount(page);
  await evaluateOnPage(
    page,
    `(()=>{
    const csv='id_hex,name,value\\r\\n0x39,MAP3_PWR,520\\r\\n0x30,TORQUE_LIMIT,2400\\r\\n0x102,MAX_DC_CHG_CURRENT,75\\r\\n';
    const transfer=new DataTransfer();transfer.items.add(new File([csv],'synthetic.csv',{type:'text/csv'}));
    const picker=document.querySelector('[type=file]');picker.files=transfer.files;picker.dispatchEvent(new Event('change',{bubbles:true}));
  })()`
  );
  await waitOnPage(page, "document.querySelectorAll('.backup-difference').length===2", "only differing backup rows");
  assert.equal(await parameterWriteCount(page), before, "Import only reads and compares.");
  const indices = (await evaluateOnPage(
    page,
    "[...document.querySelectorAll('.backup-difference')].map(row=>row.dataset.backupIndex)"
  )) as string[];
  assert.deepEqual(indices, ["57", "48"]);
  for (const [offset, index] of indices.entries()) {
    const version = await evaluateOnPage(
      page,
      `ridingPreview('lib/service-backup.js').backupDifferences.rawVal.find(row=>row.parameter.index===${index}).version`
    );
    await confirmServiceButton(page, `[data-backup-index="${index}"] button`, `backup:${version}:${index}`);
    assert.equal(await parameterWriteCount(page), Number(before) + offset + 1);
    assert.equal(
      await evaluateOnPage(page, `document.querySelector('[data-backup-index="${index}"] button').textContent`),
      "Done"
    );
  }
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.service-backup > [role=status]').textContent"),
    "Differences applied. Restart bike to apply."
  );
  assert.equal(
    await evaluateOnPage(
      page,
      "SERVICE_PARAMETER_REQUESTS.filter(request=>request.method==='POST'&&request.url.startsWith('/vcu-write')).every(request=>new URL(request.url,'http://fixture.invalid').searchParams.get('action')==='parameter')"
    ),
    true,
    "Backup never calls the batch endpoint."
  );
  await evaluateOnPage(page, "document.querySelector('.service-recent').open=true");
  await evaluateOnPage(page, FRAME);
  assert.equal(
    await evaluateOnPage(page, "document.querySelector('.service-recent').textContent.includes('confirmed')"),
    true
  );
}

function parameterWriteCount(page: HeadlessPage) {
  return evaluateOnPage(
    page,
    "SERVICE_PARAMETER_REQUESTS.filter(request=>request.method==='POST'&&request.url.startsWith('/vcu-write')).length"
  );
}
