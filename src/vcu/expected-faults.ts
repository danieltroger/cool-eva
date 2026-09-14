import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFileDurably } from "../storage/durable.ts";
import { MAX_COMPONENT, MIN_COMPONENT } from "../diagnostics/freeze-frame.ts";

// The codes this bike is EXPECTED to have, so a new one stands out.
//
// ⚠️ DATA ON THE PI, NOT A LIST IN THE REPO. Which faults are expected is a fact about one
// motorcycle and about what its owner has done to it — today: the "turn all lights off"
// feature, and a water pump hardwired to the heated-grip output so the VCU's pump driver
// reads open. Another Eva Ribelle running this software has a different list, and a list
// compiled into the binary would be wrong for every bike but one.
//
// ⚠️ AND IT IS SEEDED WITH NOTHING. The five codes issue #226 names are the symptom-1
// SHORT-circuit variants (B1001/B1003/B1010/B1013/P0A06) while the freeze frames captured
// off this bike hold the symptom-0 OPEN-circuit ones (B1000/B1002/B1009/B1012/P0A07) with
// the light currents reading 0 mA — which is what switching a light off physically does.
// A seeded list would have muted the wrong five and left the right five looking new.
//
// ⚠️ KEYED ON (component, symptom), never on the OBD code, because the OBD column is not
// unique: `U0182` is both (39,3) and (40,3). It is also the key the bike's own active list
// speaks and the one `public/views/faults.js` already has on a code line.

const FILE = "expected-faults.json";

/** One code the owner has marked as expected. */
export interface ExpectedFault {
  component: number;
  symptom: number;
}

/** The file's contents, and what GET /expected-faults serves. */
export interface ExpectedFaults {
  entries: ExpectedFault[];
  /** Wall clock of the last change, or null when nothing has ever been marked. */
  updatedAt: number | null;
}

/**
 * The symptom is the status byte's high nibble, so 0…15.
 *
 * Stated here rather than imported because ../diagnostics/freeze-frame.ts derives it with
 * a shift rather than naming a range. Anything outside is a client that made it up.
 */
const MIN_SYMPTOM = 0;
const MAX_SYMPTOM = 15;

const EMPTY: ExpectedFaults = { entries: [], updatedAt: null };

/** The tail of the write chain. See `setExpectedFault`. */
let writes: Promise<void> = Promise.resolve();

/** The marked codes, or an empty list when this Pi has none. Never throws into a handler. */
export async function loadExpectedFaults(directory: string): Promise<ExpectedFaults> {
  const path = join(directory, FILE);
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`expected-faults: could not read ${path}:`, err);
    }
    return EMPTY;
  }
  try {
    const parsed = JSON.parse(text) as ExpectedFaults;
    if (!Array.isArray(parsed.entries) || !parsed.entries.every(isExpectedFault)) {
      // Empty rather than a throw, and LOUD rather than silent: the page then shows every
      // code unmarked, which is the safe direction — nothing is hidden, and a code that
      // should have been muted merely looks new.
      console.warn(`expected-faults: ${path} parsed but is not a list of (component, symptom) pairs`);
      return EMPTY;
    }
    return { entries: parsed.entries, updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null };
  } catch (err) {
    console.warn(`expected-faults: ${path} is not valid JSON:`, err);
    return EMPTY;
  }
}

/**
 * Marks one code expected, or unmarks it. Returns the whole list as it now stands.
 *
 * Idempotent both ways, because the control that calls it is a toggle on a phone over a
 * garage wifi link that drops: sending "expected" twice must not produce two entries, and
 * sending "not expected" for something unmarked is not an error.
 */
export async function setExpectedFault(
  directory: string,
  fault: ExpectedFault,
  expected: boolean
): Promise<ExpectedFaults> {
  // ⚠️ SERIALISED, because this is a read-modify-write and the HTTP layer will happily run
  // two at once. Both would load the same list, both would filter it, and the second
  // `replaceFileDurably` would rename its copy over the first — losing a mark with nothing
  // logged, on a control whose whole job is remembering one bit per code. A promise chain
  // rather than a lock: there is one process and one file.
  const queued = writes.then(() => applyExpectedFault(directory, fault, expected));
  // The chain must not break on a failure, or every later write is refused for the life of
  // the process. The REJECTION still reaches the caller through `queued`.
  writes = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

/** One write. Only ever called from `setExpectedFault`'s chain, never concurrently. */
async function applyExpectedFault(directory: string, fault: ExpectedFault, expected: boolean): Promise<ExpectedFaults> {
  const current = await loadExpectedFaults(directory);
  const without = current.entries.filter(
    entry => entry.component !== fault.component || entry.symptom !== fault.symptom
  );
  if (!expected && without.length === current.entries.length) {
    return current;
  }
  if (expected && without.length !== current.entries.length) {
    return current;
  }
  const entries = expected ? [...without, fault].sort(byComponentThenSymptom) : without;
  const next: ExpectedFaults = { entries, updatedAt: Date.now() };
  await mkdir(directory, { recursive: true });
  await replaceFileDurably(join(directory, FILE), `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `expected-faults: ${fault.component}/${fault.symptom} ${expected ? "marked expected" : "unmarked"} — ${entries.length} on the list`
  );
  return next;
}

/** Whether a (component, symptom) pair is one this repo could ever have read off the bike. */
export function isValidFaultKey(component: number, symptom: number): boolean {
  return (
    Number.isInteger(component) &&
    component >= MIN_COMPONENT &&
    component <= MAX_COMPONENT &&
    Number.isInteger(symptom) &&
    symptom >= MIN_SYMPTOM &&
    symptom <= MAX_SYMPTOM
  );
}

function isExpectedFault(entry: unknown): entry is ExpectedFault {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry as Partial<ExpectedFault>;
  return (
    typeof candidate.component === "number" &&
    typeof candidate.symptom === "number" &&
    isValidFaultKey(candidate.component, candidate.symptom)
  );
}

function byComponentThenSymptom(left: ExpectedFault, right: ExpectedFault): number {
  return left.component - right.component || left.symptom - right.symptom;
}
