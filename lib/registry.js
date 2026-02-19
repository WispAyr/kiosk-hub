/**
 * Kiosk Registry — tracks all connected kiosks, their state, and WebSocket connections.
 */

class KioskRegistry {
  constructor() {
    /** @type {Map<string, object>} kioskId → kiosk state */
    this.kiosks = new Map();
    /** @type {Map<string, import('ws').WebSocket>} kioskId → ws connection */
    this.connections = new Map();
    /** @type {Map<string, Function>} requestId → resolve callback */
    this.pendingRequests = new Map();

    // Stale check every 60s
    setInterval(() => this._checkStale(), 60_000);
  }

  /**
   * Register or update a kiosk on connect.
   */
  register(kioskId, ws, meta = {}) {
    const existing = this.kiosks.get(kioskId);
    const now = Date.now();

    this.kiosks.set(kioskId, {
      kioskId,
      kioskName: meta.kioskName || existing?.kioskName || kioskId,
      status: 'online',
      connectedAt: existing?.connectedAt || now,
      lastHeartbeat: now,
      lastSeen: now,
      ip: meta.ip || null,
      metrics: existing?.metrics || {},
      meta: { ...existing?.meta, ...meta }
    });

    // Close old connection if exists
    const oldWs = this.connections.get(kioskId);
    if (oldWs && oldWs !== ws && oldWs.readyState <= 1) {
      try { oldWs.close(1000, 'replaced'); } catch {}
    }

    this.connections.set(kioskId, ws);
    this._log(`Registered kiosk: ${kioskId} (${meta.kioskName || kioskId})`);
  }

  /**
   * Mark kiosk as disconnected.
   */
  disconnect(kioskId) {
    const kiosk = this.kiosks.get(kioskId);
    if (kiosk) {
      kiosk.status = 'offline';
      kiosk.disconnectedAt = Date.now();
    }
    this.connections.delete(kioskId);
    this._log(`Kiosk disconnected: ${kioskId}`);
  }

  /**
   * Update heartbeat data.
   */
  heartbeat(kioskId, data) {
    const kiosk = this.kiosks.get(kioskId);
    if (!kiosk) return;

    kiosk.lastHeartbeat = Date.now();
    kiosk.lastSeen = Date.now();
    kiosk.status = 'online';
    kiosk.metrics = { ...data, timestamp: Date.now() };
  }

  /**
   * Send a command to a kiosk and wait for response.
   * @returns {Promise<object>} response data
   */
  sendCommand(kioskId, plugin, action, data = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const ws = this.connections.get(kioskId);
      if (!ws || ws.readyState !== 1) {
        return reject(new Error(`Kiosk ${kioskId} is not connected`));
      }

      const requestId = `${kioskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, (response) => {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.data || response);
        }
      });

      const msg = JSON.stringify({
        type: 'command',
        requestId,
        plugin,
        action,
        data
      });

      ws.send(msg);
    });
  }

  /**
   * Send a command to ALL connected kiosks.
   */
  async broadcast(plugin, action, data = {}) {
    const results = {};
    const promises = [];

    for (const [kioskId] of this.connections) {
      promises.push(
        this.sendCommand(kioskId, plugin, action, data)
          .then(res => { results[kioskId] = { success: true, data: res }; })
          .catch(err => { results[kioskId] = { success: false, error: err.message }; })
      );
    }

    await Promise.allSettled(promises);
    return results;
  }

  /**
   * Handle a response from a kiosk agent.
   */
  handleResponse(requestId, data) {
    const resolver = this.pendingRequests.get(requestId);
    if (resolver) {
      resolver(data);
    }
  }

  /**
   * Push an update (new plugin code) to a kiosk.
   */
  pushUpdate(kioskId, pluginName, code) {
    const ws = this.connections.get(kioskId);
    if (!ws || ws.readyState !== 1) {
      throw new Error(`Kiosk ${kioskId} is not connected`);
    }

    ws.send(JSON.stringify({
      type: 'update',
      plugin: pluginName,
      code
    }));
  }

  /**
   * Get kiosk state (safe copy, no ws ref).
   */
  get(kioskId) {
    const kiosk = this.kiosks.get(kioskId);
    if (!kiosk) return null;
    return { ...kiosk, connected: this.connections.has(kioskId) && this.connections.get(kioskId).readyState === 1 };
  }

  /**
   * List all kiosks.
   */
  list() {
    const result = [];
    for (const [kioskId, kiosk] of this.kiosks) {
      const ws = this.connections.get(kioskId);
      result.push({
        ...kiosk,
        connected: ws ? ws.readyState === 1 : false
      });
    }
    return result;
  }

  /**
   * Mark stale kiosks (no heartbeat in 90s).
   */
  _checkStale() {
    const now = Date.now();
    for (const [kioskId, kiosk] of this.kiosks) {
      if (kiosk.status === 'online' && now - kiosk.lastHeartbeat > 90_000) {
        kiosk.status = 'stale';
        this._log(`Kiosk marked stale: ${kioskId} (no heartbeat for 90s)`);
      }
    }
  }

  _log(msg) {
    console.log(`[${new Date().toISOString()}] [Registry] ${msg}`);
  }
}

export default KioskRegistry;
