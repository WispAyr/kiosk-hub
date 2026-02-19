/**
 * Metrics Store — stores historical metrics for kiosks in memory with a rolling window.
 */

class MetricsStore {
  constructor(maxPerKiosk = 2880) {
    // 2880 = 24 hours at 30s intervals
    this.maxPerKiosk = maxPerKiosk;
    /** @type {Map<string, Array<object>>} */
    this.store = new Map();
  }

  /**
   * Record a metrics snapshot.
   */
  record(kioskId, data) {
    if (!this.store.has(kioskId)) {
      this.store.set(kioskId, []);
    }

    const entries = this.store.get(kioskId);
    entries.push({
      ...data,
      timestamp: Date.now()
    });

    // Trim to max
    while (entries.length > this.maxPerKiosk) {
      entries.shift();
    }
  }

  /**
   * Query metrics for a kiosk.
   * @param {string} kioskId
   * @param {object} opts
   * @param {number} [opts.since] - timestamp ms
   * @param {number} [opts.limit] - max entries to return
   * @returns {Array<object>}
   */
  query(kioskId, opts = {}) {
    const entries = this.store.get(kioskId) || [];
    let result = entries;

    if (opts.since) {
      result = result.filter(e => e.timestamp >= opts.since);
    }

    if (opts.limit) {
      result = result.slice(-opts.limit);
    }

    return result;
  }

  /**
   * Get the latest metric entry for a kiosk.
   */
  latest(kioskId) {
    const entries = this.store.get(kioskId) || [];
    return entries[entries.length - 1] || null;
  }

  /**
   * Get summary stats for a kiosk over a time range.
   */
  summary(kioskId, since = Date.now() - 3600_000) {
    const entries = this.query(kioskId, { since });
    if (entries.length === 0) return null;

    const cpuValues = entries.map(e => e.cpu).filter(v => v != null);
    const ramValues = entries.map(e => e.ram).filter(v => v != null);

    return {
      count: entries.length,
      period: {
        from: entries[0].timestamp,
        to: entries[entries.length - 1].timestamp
      },
      cpu: cpuValues.length > 0 ? {
        avg: Math.round(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length),
        min: Math.min(...cpuValues),
        max: Math.max(...cpuValues)
      } : null,
      ram: ramValues.length > 0 ? {
        avg: Math.round(ramValues.reduce((a, b) => a + b, 0) / ramValues.length),
        min: Math.min(...ramValues),
        max: Math.max(...ramValues)
      } : null
    };
  }
}

export default MetricsStore;
