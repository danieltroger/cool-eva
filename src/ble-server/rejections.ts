export class Rejections {
  #lastLog = Number.NEGATIVE_INFINITY;
  #pending = 0;
  #reason = "";
  #refusalWindow = Number.NEGATIVE_INFINITY;
  #refusals = 0;

  problem(reason: string, now: number): void {
    this.#pending++;
    this.#reason = reason.slice(0, 160);
    if (now - this.#lastLog >= 2_000) {
      this.flush();
      this.#lastLog = now;
    }
  }

  allowRefusal(now: number): boolean {
    if (now - this.#refusalWindow >= 2_000) {
      this.#refusalWindow = now;
      this.#refusals = 0;
    }
    if (this.#refusals >= 4) return false;
    this.#refusals++;
    return true;
  }

  flush(): void {
    if (this.#pending === 0) return;
    console.log(`ble-server: rejected ${this.#pending} frame/message(s): ${this.#reason}`);
    this.#pending = 0;
  }
}
