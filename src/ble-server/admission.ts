export class Admission {
  #count = 0;
  #bytes = 0;

  get count(): number {
    return this.#count;
  }
  get bytes(): number {
    return this.#bytes;
  }

  take(bytes: number): boolean {
    if (this.#count >= 32 || this.#bytes + bytes > 128 * 1024) return false;
    this.#count++;
    this.#bytes += bytes;
    return true;
  }

  release(bytes: number): void {
    this.#count--;
    this.#bytes -= bytes;
  }
}
