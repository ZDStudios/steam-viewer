/**
 * Tiny TTL cache with an LRU-ish eviction policy plus in-flight de-duplication.
 *
 * Steam's public endpoints are rate limited (roughly 200 requests / 5 minutes
 * per IP for `appdetails`), and every browser connected to this relay shares a
 * single outbound IP. Caching is therefore not an optimisation here, it is what
 * keeps the service usable.
 */
export class TtlCache {
  constructor({ maxEntries = 2000 } = {}) {
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.inflight = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency: Map preserves insertion order, so re-inserting moves the
    // key to the end and makes the first key the least recently used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!(ttlMs > 0)) return value;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  delete(key) {
    this.map.delete(key);
  }

  /**
   * Resolve `key` from cache, or run `producer()` exactly once even if several
   * callers ask for the same key at the same moment.
   */
  async wrap(key, ttlMs, producer) {
    const cached = this.get(key);
    if (cached !== undefined) {
      this.hits += 1;
      return { value: cached, cached: true };
    }

    const pending = this.inflight.get(key);
    if (pending) return { value: await pending, cached: true };

    this.misses += 1;
    const promise = (async () => producer())();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value, ttlMs);
      return { value, cached: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  stats() {
    return {
      entries: this.map.size,
      inflight: this.inflight.size,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
