import { execFile } from "child_process";
import { readdir, readFile, readlink, writeFile } from "fs/promises";
import { promisify } from "util";

const runCommand = promisify(execFile);

// The I/O half of the cooling-fan driver: the kernel's hardware PWM through sysfs, and
// the IBT-2's two enable pins through `pinctrl`. No policy lives here — the kick-start,
// the minimum duty and the cap are in ./control.ts, split the way ble/protocol.ts is
// split from ble/client.ts so the arithmetic can be checked without a Pi.
//
// Deliberately sysfs rather than the `pigpio` npm package: that is a native build, and
// CLAUDE.md's deploy notes are mostly about how badly native modules go on this Pi.
//
// The wiring, the `dtoverlay=pwm,pin=18,func=2` line this needs in config.txt, the udev
// rule that makes these files writable without root, and why idling pulls the enables
// LOW rather than dropping the duty to zero: docs/fan-control.md.

/**
 * 50 000 ns = 20 kHz. Above the fan's own blade noise and at the top of the audible
 * band, so the carrier is not what you hear; the BTS7960's switching losses are still
 * small there.
 */
export const PWM_PERIOD_NS = 50_000;

const PWM_CLASS_DIR = "/sys/class/pwm";

/** The channel `dtoverlay=pwm,pin=18,func=2` exposes: PWM0, on GPIO18 / header pin 12. */
const PWM_CHANNEL = 0;

/**
 * The IBT-2's R_EN and L_EN, on header pins 11 and 13. Both HIGH activates the bridge;
 * both LOW is standby with every FET off, which is the only safe way to idle.
 */
const ENABLE_GPIOS = [17, 27];

/** One brought-up PWM channel plus the two enable pins. Every method can reject. */
export interface FanPwm {
  /** `/sys/class/pwm/pwmchipN/pwm0`, as discovered. For the journal and error text. */
  readonly channelPath: string;
  setDutyPercent: (percent: number) => Promise<void>;
  setOutputEnabled: (on: boolean) => Promise<void>;
  setBridgeEnabled: (on: boolean) => Promise<void>;
}

/**
 * Drops both enables, finds the PWM chip, exports channel 0 and leaves it at 20 kHz,
 * duty 0, output off — i.e. a bridge in standby that has not been asked to do anything.
 *
 * Throws with a message that names the missing config.txt line or udev rule, because
 * every failure here is a setup step nobody did rather than a hardware fault.
 */
export async function openFanPwm(): Promise<FanPwm> {
  // ⚠️ FIRST, ahead of everything else here. A SIGKILL skips the shutdown handler, and
  // `Restart=on-failure` / `RestartSec=5` (scripts/setup-service.ts) bring this process
  // back about five seconds later — so bring-up can begin with both enables still HIGH
  // and the channel still driving. Dropping the duty under a live bridge would pass
  // through "enabled at 0 %", which shorts the motor. Same mirror rule as goIdle().
  await setEnablePins(false);

  const chipPath = await findPwmChip();
  const channelPath = `${chipPath}/pwm${PWM_CHANNEL}`;
  const existingPeriodNs = await exportChannel(chipPath, channelPath);

  // Period FIRST on a freshly exported channel, where it reads 0: __pwm_apply() rejects
  // every duty_cycle write against a zero period with EINVAL, ahead of its "nothing
  // changed, return 0" early return — so even writing 0 fails. pwm-bcm2835 defines no
  // .get_state, so nothing ever refreshes that zero from the hardware, and the export
  // survives a restart, which makes the failure permanent rather than first-boot only.
  // Duty first is right only when the period SHRINKS under a live duty, which cannot
  // happen here: PWM_PERIOD_NS is a constant, so an already-exported channel holds it.
  if (existingPeriodNs === 0) {
    await writeAttribute(channelPath, "period", String(PWM_PERIOD_NS));
    await writeAttribute(channelPath, "duty_cycle", "0");
  } else {
    await writeAttribute(channelPath, "duty_cycle", "0");
    await writeAttribute(channelPath, "period", String(PWM_PERIOD_NS));
  }
  await writeAttribute(channelPath, "enable", "0");

  console.log(`fan: PWM ready on ${channelPath} at ${PWM_PERIOD_NS} ns, bridge in standby`);
  return {
    channelPath,
    setDutyPercent: percent => writeAttribute(channelPath, "duty_cycle", String(dutyToNanoseconds(percent))),
    setOutputEnabled: on => writeAttribute(channelPath, "enable", on ? "1" : "0"),
    setBridgeEnabled: on => setEnablePins(on),
  };
}

/**
 * A duty percentage as the nanoseconds sysfs wants in `duty_cycle`.
 *
 * Pure and exported so the one piece of arithmetic in this file is testable with no Pi,
 * per CLAUDE.md's rule about decoders. Out-of-range input is clamped rather than
 * rejected: this is the last stop before a hardware register, and ./control.ts has
 * already decided what is allowed.
 */
export function dutyToNanoseconds(percent: number, periodNs: number = PWM_PERIOD_NS): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  const clamped = Math.min(Math.max(percent, 0), 100);
  return Math.round((clamped / 100) * periodNs);
}

/**
 * Which `pwmchipN` the overlay landed on.
 *
 * ⚠️ Not hardcoded to 0: the number moves with the kernel and with what else is loaded,
 * and a hardcoded 0 on a kernel that numbered it 2 would silently drive somebody else's
 * PWM. Candidates are chips that offer at least one channel; among those, a chip whose
 * `device` link names an SoC `.pwm` block wins over one that does not.
 */
async function findPwmChip(): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(PWM_CLASS_DIR);
  } catch (error) {
    throw new Error(
      `no ${PWM_CLASS_DIR} at all — this kernel has no PWM chip. Add \`dtoverlay=pwm,pin=18,func=2\` to ` +
        `/boot/firmware/config.txt and reboot (docs/fan-control.md). Underlying error: ${(error as Error).message}`
    );
  }

  const chips = entries.filter(entry => /^pwmchip\d+$/.test(entry)).sort(byChipNumber);
  const usable: string[] = [];
  const preferred: string[] = [];
  for (const chip of chips) {
    const path = `${PWM_CLASS_DIR}/${chip}`;
    if ((await channelCount(path)) <= PWM_CHANNEL) {
      continue;
    }
    usable.push(chip);
    if ((await deviceLinkOf(path)).includes(".pwm")) {
      preferred.push(chip);
    }
  }

  if (usable.length === 0) {
    throw new Error(
      `${PWM_CLASS_DIR} lists ${chips.length === 0 ? "no pwmchip" : chips.join(", ")} but none offers channel ` +
        `${PWM_CHANNEL}. Add \`dtoverlay=pwm,pin=18,func=2\` to /boot/firmware/config.txt and reboot ` +
        `(docs/fan-control.md).`
    );
  }
  const chosen = preferred[0] ?? usable[0];
  if (preferred.length === 0) {
    console.warn(
      `fan: none of ${usable.join(", ")} names a .pwm device, so ${chosen} was taken as the lowest-numbered ` +
        `usable chip. Check it is the overlay's and not another driver's before spinning the fan.`
    );
  } else if (usable.length > 1) {
    console.log(`fan: ${usable.join(", ")} are usable; picked ${chosen} because its device is an SoC .pwm block`);
  }
  return `${PWM_CLASS_DIR}/${chosen}`;
}

/** `pwmchip12` after `pwmchip2`, which a plain string sort gets backwards. */
function byChipNumber(left: string, right: string): number {
  return Number(left.replace("pwmchip", "")) - Number(right.replace("pwmchip", ""));
}

/** How many channels a chip offers, or 0 if it will not say. */
async function channelCount(chipPath: string): Promise<number> {
  try {
    return Number.parseInt((await readFile(`${chipPath}/npwm`, "utf-8")).trim(), 10) || 0;
  } catch (error) {
    console.warn(`fan: could not read ${chipPath}/npwm, skipping that chip:`, (error as Error).message);
    return 0;
  }
}

/** Where a chip's `device` symlink points, or "" — only ever used as a hint. */
async function deviceLinkOf(chipPath: string): Promise<string> {
  try {
    return await readlink(`${chipPath}/device`);
  } catch (error) {
    console.log(`fan: ${chipPath} has no readable device link (${(error as Error).message}) — not a disqualifier`);
    return "";
  }
}

/**
 * Exports channel 0, tolerating a channel an earlier run of this service left behind,
 * and answers with the period that channel currently holds in nanoseconds — 0 on a fresh
 * export, which is what decides the write order back in openFanPwm().
 */
async function exportChannel(chipPath: string, channelPath: string): Promise<number> {
  try {
    await writeFile(`${chipPath}/export`, String(PWM_CHANNEL));
  } catch (error) {
    // EBUSY is the routine case — the channel is already exported, which a restart of
    // this service produces every time, since nothing here ever unexports.
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") {
      throw new Error(`could not export channel ${PWM_CHANNEL} on ${chipPath}: ${(error as Error).message}`);
    }
    console.log(`fan: channel ${PWM_CHANNEL} was already exported on ${chipPath} — reusing it`);
  }

  // Confirm the directory is really there and readable before anything is written into
  // it. udev creates and chowns it a moment after the export, so this is also where the
  // "files exist but belong to root" case surfaces, with the rule to fix it named. The
  // value read here is not thrown away: it is the zero-period case openFanPwm() orders
  // its writes around, so no extra syscall pays for that.
  try {
    const period = await readFile(`${channelPath}/period`, "utf-8");
    return Number.parseInt(period.trim(), 10) || 0;
  } catch (error) {
    throw new Error(
      `${channelPath} is not usable after exporting (${(error as Error).message}). Either the export did not take, ` +
        `or the udev rule that gives the \`gpio\` group /sys/class/pwm is missing — docs/fan-control.md.`
    );
  }
}

async function writeAttribute(channelPath: string, name: string, value: string): Promise<void> {
  try {
    await writeFile(`${channelPath}/${name}`, value);
  } catch (error) {
    throw new Error(
      `writing ${value} to ${channelPath}/${name} failed: ${(error as Error).message}` +
        ((error as NodeJS.ErrnoException).code === "EACCES"
          ? " — run as root, or install the udev rule in docs/fan-control.md"
          : "")
    );
  }
}

/**
 * Drives both IBT-2 enables together. HIGH activates the bridge; LOW is standby.
 *
 * `pinctrl` is spawned rather than linked against because the enables change twice a
 * session, so a process is cheap and a native GPIO module is not (see the file header).
 */
async function setEnablePins(high: boolean): Promise<void> {
  const level = high ? "dh" : "dl";
  for (const gpio of ENABLE_GPIOS) {
    try {
      await runCommand("pinctrl", ["set", String(gpio), "op", level]);
    } catch (error) {
      // A missing `pinctrl` is not a mystery worth debugging at 2 a.m., so it says so.
      // It also fails SAFE: config.txt's `gpio=17,op,dl` / `gpio=27,op,dl` leave both
      // enables low at boot, so a Pi that cannot run pinctrl has a bridge in standby.
      const detail =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "`pinctrl` is not installed (Bookworm: `sudo apt install raspi-utils`). The bridge stays in the " +
            "standby config.txt leaves it in, so the fan will not spin."
          : (error as Error).message;
      throw new Error(`could not drive GPIO${gpio} ${level}: ${detail}`);
    }
  }
}
