/** Tracks handler promises independently of their client sockets. */
export class RequestTracker {
  #active = 0;
  #waiters = new Set<() => void>();

  enter(): () => void {
    this.#active++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#active--;
      if (this.#active === 0) {
        for (const resolve of this.#waiters) resolve();
        this.#waiters.clear();
      }
    };
  }

  async drain(): Promise<void> {
    if (this.#active === 0) return;
    await new Promise<void>((resolve) => this.#waiters.add(resolve));
  }
}
