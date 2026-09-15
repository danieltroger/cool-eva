// The preview harness: what a service-mode write does, for both preview pages.
//
// Split out of preview-harness-pi.js rather than living beside the stubbed `fetch` that calls
// it, because it is the one part of the harness that MODELS something rather than carrying it:
// the journal a write is recorded in, the three endings a Mode 04 clear can have, and the
// sweep that steps while the page watches. Also because the two together were 493 lines.
//
// Injected before preview-harness-pi.js; the contract and the order are in
// scripts/preview-harness.ts, and the strings that may not appear here are in
// scripts/preview-harness-browser.js's header.

/** Advances a sweep started from the preview, one poll at a time. */
function stepSweep() {
  const run = READ_STATE.run;
  if (run.phase !== "running") {
    return;
  }
  const read = Math.min(run.tally.total, run.tally.read + 19);
  run.tally.read = read;
  run.tally.byStatus.read = read;
  run.tally.micros[0].read = Math.min(223, Math.round(read * 0.86));
  run.tally.micros[1].read = read - run.tally.micros[0].read;
  if (read >= run.tally.total - 44) {
    run.phase = "finished";
    run.complete = true;
    run.finishedAt = Date.now();
    // ⚠️ `expected` belongs to the RUNNING arm alone, so a sweep that finishes must lose it
    // rather than carry it over — the Pi builds a fresh state per phase (readState()), and a
    // check that reads the literal cannot see a field re-added out here.
    delete run.expected;
    run.tally.read = 233;
    run.tally.byStatus.read = 233;
    run.tally.micros = [
      { micro: "A9", read: 201, failed: 22 },
      { micro: "A8", read: 32, failed: 22 },
    ];
    READ_STATE.export = { rows: 233, readAt: Date.now(), complete: true };
  }
}

function serviceWrite(query) {
  const action = query.get("action");
  const record = extra => {
    JOURNAL.unshift(Object.assign({ at: Date.now(), clockTrustworthy: true }, extra));
    JOURNAL.length = Math.min(JOURNAL.length, 6);
  };

  if (action === "read-service-stamp") {
    // ⚠️ The fixture is what the bike REALLY answered on 2026-09-08, message, journal
    // and raw words together. A plausible-looking 2024 date beside a zero stamp would
    // make the preview disagree with itself in the one screenshot this exists for.
    record({
      action: "read-service-stamp",
      status: "read",
      before: "2000-01-01T00:00:00.000Z",
      after: 0,
      rawHex: "13E8=0000 13E9=0000 13EA=0000 13EB=0000",
    });
    return {
      action: "read-service-stamp",
      status: "read",
      message:
        "Last service stamped 2000-01-01T00:00:00.000Z at 0 (km or miles, per market). " +
        "\u26a0\ufe0f reads zero — no service point has ever been set on this bike, or A8 answered with an empty cell",
      succeeded: true,
      stamp: {
        // The 2026-09-08 payload, as A8 really answered: four zero WORDs.
        // docs/service-stamp.md §2.
        before: {
          raw: { dateLow: 0, dateHigh: 0, odometerLow: 0, odometerHigh: 0 },
          dateSeconds: 0,
          dateIso: "2000-01-01T00:00:00.000Z",
          odometer: 0,
          implausible:
            "reads zero — no service point has ever been set on this bike, or A8 answered with an empty cell",
        },
        after: null,
      },
    };
  }
  if (action === "set-service-point") {
    // Over the zero stamp the read above reports — the same fixture, one action later.
    record({
      action: "set-service-point",
      status: "started",
      before: "2000-01-01T00:00:00.000Z",
      after: "2026-09-08",
    });
    return {
      action: "set-service-point",
      status: "started",
      message:
        "Service point set. The bike stamped 2026-09-08T12:17:06.000Z at 14849, over " +
        "2000-01-01T00:00:00.000Z at 0.",
      succeeded: true,
    };
  }
  if (action === "clear-dtcs") {
    // ⚠️ The 2026-09-13 press, verbatim: 46 stored before, 5 after, PID 31 19 671 km → 0.
    // Round invented numbers would let the sentence and the counters be screenshotted
    // disagreeing, which is the one thing this card exists to prevent. `?clear=nothing` is
    // the 2026-08-08 / 2026-09-11 shape — a positive 44 with PID 31 unmoved. `?clear=retry`
    // is the commonest third: pressing again a minute later, when PID 31 already reads 0
    // and so cannot prove anything either way.
    const ending = new URLSearchParams(window.location.search).get("clear");
    const erasedNothing = ending === "nothing";
    const retry = ending === "retry";
    const clear = {
      storedBefore: retry ? 5 : 46,
      storedAfter: erasedNothing ? 46 : 5,
      distSinceClearBeforeKm: retry ? 0 : 19671,
      distSinceClearAfterKm: erasedNothing ? 19671 : 0,
      listedAfter: erasedNothing ? null : 5,
      verdict: erasedNothing ? "erased-nothing" : retry ? "unproven" : "erased",
    };
    // Derived from `clear`, not written out: a hardcoded "46 stored" put a journal line
    // beside `?clear=retry`'s counters that contradicted them.
    record({
      action: "clear-dtcs",
      status: "cleared",
      before: `${clear.storedBefore} stored, ${clear.distSinceClearBeforeKm} km since clear`,
      after: `${clear.storedAfter} stored, ${clear.distSinceClearAfterKm} km since clear`,
    });
    return {
      action: "clear-dtcs",
      status: "cleared",
      message: erasedNothing
        ? "⚠️ Mode 04 was accepted AND THE BIKE ERASED NOTHING: distance since codes cleared still reads 19671 km, which a real clear resets to zero within half a second. This has happened twice before, both times with a cable or a charge involved."
        : retry
          ? "Mode 04 accepted, but nothing here proves the bike acted on it — a positive answer alone has twice meant nothing on this bike. The list now holds 5. Distance since codes cleared already read 0 km before the press, so it cannot show a reset. Ride, then read the Faults tab."
          : "Cleared: 46 stored → 5 stored, 41 cleared. Distance since codes cleared went 19671 km → 0 km, which is the proof the bike really erased its fault memory. The list now holds 5. Codes whose faults are still active come straight back.",
      succeeded: !erasedNothing,
      clear,
    };
  }
  if (action === "sync-clock") {
    const when = new Date().toISOString();
    record({ action: "rtc-sync", status: "sent", requested: when, after: null });
    return {
      action: "rtc-sync",
      status: "sent",
      message:
        `Broadcast ${when} UTC on 0x120 (120#07E00813 0E1A0000). ` +
        "⚠️ CHECK THE DASHBOARD NOW to see whether the bike took it. " +
        "There is no reply to this frame and no documented way to read the bike's clock back, so the dash is the only " +
        "confirmation that exists. Note the bike was sent UTC, so a dash showing local time will differ by your offset. " +
        "Confirm it before using Set Service Point, which stamps whatever the bike's clock says.",
      succeeded: true,
    };
  }
  if (action === "parameter" || action === "bit") {
    const name = query.get("name");
    const target = TARGETS.find(candidate => candidate.name === name);
    if (!target) {
      return null;
    }
    let value;
    let description;
    if (action === "bit") {
      const on = query.get("on") === "1";
      const bit = target.control.bits[0];
      value = on ? target.onBike.value | bit.mask : target.onBike.value & ~bit.mask;
      description = `${name} ${bit.label} → ${on ? "ON" : "OFF"}`;
    } else {
      value = Number(query.get("value"));
      description = `${name} ${query.get("expected")} → ${value}`;
    }
    const rawHex = value.toString(16).toUpperCase().padStart(target.onBike.rawHex.length, "0");
    // The write lands, and the sweep's snapshot is updated with it — so the form goes
    // on telling the truth about what the bike holds.
    target.onBike = { value, rawHex, label: null, readAt: Date.now(), complete: true };
    record({
      action: "parameter-write",
      status: "written",
      name,
      before: Number(query.get("expected")),
      after: value,
    });
    return {
      action: "parameter-write",
      status: "written",
      message: `${description} — written and read back as ${value} (${rawHex}).`,
      succeeded: true,
      onBike: { name, value, rawHex },
    };
  }
  return null;
}

/**
 * The status payload for one request, sliced the way src/http/vcu-write.ts slices it:
 * `detail=NAME` fills in the one target, `list=0` says the caller already holds the names.
 * ⚠️ `targets: null` means NOT ASKED FOR — the page keeps its own copy — so a preview that
 * returned [] here would show an empty picker after the first refresh.
 */
function writeStatus(params) {
  const wanted = params.get("detail");
  return {
    ...WRITE_STATUS,
    targets:
      params.get("list") === "0"
        ? null
        : TARGETS.map(target => ({ name: target.name, index: target.index, micro: target.micro })),
    detail: TARGETS.find(target => target.name === wanted) ?? null,
  };
}
