import { createVirtualClock } from "./virtual-clock.ts";
import type { TimerHandle } from "../public/lib/ble-state.js";

export function bleClock() {
  const clock = createVirtualClock(0);
  const active = new Set<number>();
  let nextId = 0;
  return {
    now: clock.now,
    advance: clock.advance,
    count: () => active.size,
    setTimer: (callback: () => void, milliseconds: number): TimerHandle => {
      const id = ++nextId;
      active.add(id);
      clock.setTimer(() => {
        if (active.delete(id)) {
          callback();
        }
      }, milliseconds);
      return id;
    },
    clearTimer: (timer: TimerHandle): void => {
      active.delete(Number(timer));
    },
  };
}
