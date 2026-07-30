/**
 * Serialises outbound Steam requests: at most `concurrency` in flight, and at
 * least `minGapMs` between two dispatches. Keeps us well under Steam's public
 * rate limits no matter how many browsers are connected.
 */
export class Limiter {
  constructor({ concurrency = 4, minGapMs = 60 } = {}) {
    this.concurrency = concurrency;
    this.minGapMs = minGapMs;
    this.active = 0;
    this.lastStart = 0;
    this.queue = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    if (this.active >= this.concurrency || this.queue.length === 0) return;

    const wait = Math.max(0, this.lastStart + this.minGapMs - Date.now());
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.#pump();
        }, wait);
      }
      return;
    }

    const job = this.queue.shift();
    this.active += 1;
    this.lastStart = Date.now();

    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active -= 1;
        this.#pump();
      });

    // A free slot may still be available for the next tick.
    this.#pump();
  }

  stats() {
    return { active: this.active, queued: this.queue.length };
  }
}

/** Run `mapper` over `items` with bounded concurrency, preserving order. */
export async function mapPool(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });

  await Promise.all(workers);
  return results;
}
