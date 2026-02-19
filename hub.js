/**
 * Skynet Kiosk Hub
 * WebSocket server + REST API for managing remote kiosk agents.
 * Port 3750 — both WS and HTTP on the same server.
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import KioskRegistry from './lib/registry.js';
import MetricsStore from './lib/metrics.js';

const PORT = parseInt(process.env.PORT || '3750', 10);
const HUB_TOKEN = process.env.HUB_TOKEN || 'skynet-kiosk-token-2025';

const registry = new KioskRegistry();
const metrics = new MetricsStore();

// ─── Express REST API ──────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'kiosk-hub', uptime: process.uptime() });
});

// List all kiosks
app.get('/api/kiosks', (_req, res) => {
  res.json(registry.list());
});

// Broadcast command to all kiosks
app.post('/api/kiosks/broadcast', async (req, res) => {
  try {
    const { plugin, action, data } = req.body;
    if (!plugin || !action) {
      return res.status(400).json({ error: 'plugin and action are required' });
    }
    const results = await registry.broadcast(plugin, action, data);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single kiosk details
app.get('/api/kiosks/:id', (req, res) => {
  const kiosk = registry.get(req.params.id);
  if (!kiosk) return res.status(404).json({ error: 'Kiosk not found' });
  res.json(kiosk);
});

// Screenshot
app.get('/api/kiosks/:id/screenshot', async (req, res) => {
  try {
    const result = await registry.sendCommand(req.params.id, 'screenshot', 'capture', {}, 15000);
    if (result.image) {
      // Return as image
      const buf = Buffer.from(result.image, 'base64');
      res.set('Content-Type', 'image/png');
      res.set('Content-Length', buf.length);
      return res.send(buf);
    }
    res.json(result);
  } catch (err) {
    res.status(err.message.includes('not connected') ? 404 : 500).json({ error: err.message });
  }
});

// Generic command
app.post('/api/kiosks/:id/command', async (req, res) => {
  try {
    const { plugin, action, data, timeout } = req.body;
    if (!plugin || !action) {
      return res.status(400).json({ error: 'plugin and action are required' });
    }
    const result = await registry.sendCommand(req.params.id, plugin, action, data || {}, timeout || 30000);
    res.json(result);
  } catch (err) {
    res.status(err.message.includes('not connected') ? 404 : 500).json({ error: err.message });
  }
});

// Browser navigate
app.post('/api/kiosks/:id/browser/navigate', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const result = await registry.sendCommand(req.params.id, 'browser', 'navigate', { url });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Browser refresh
app.post('/api/kiosks/:id/browser/refresh', async (req, res) => {
  try {
    const result = await registry.sendCommand(req.params.id, 'browser', 'refresh');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reboot
app.post('/api/kiosks/:id/reboot', async (req, res) => {
  try {
    const result = await registry.sendCommand(req.params.id, 'system', 'reboot', { delay: req.body.delay || 5 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shell command
app.post('/api/kiosks/:id/shell', async (req, res) => {
  try {
    const { command, powershell, timeout } = req.body;
    if (!command) return res.status(400).json({ error: 'command is required' });
    const result = await registry.sendCommand(
      req.params.id, 'shell', 'exec',
      { command, powershell: powershell !== false },
      timeout || 30000
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metrics
app.get('/api/kiosks/:id/metrics', (req, res) => {
  const { since, limit } = req.query;
  const opts = {};
  if (since) opts.since = parseInt(since, 10);
  if (limit) opts.limit = parseInt(limit, 10);

  const data = metrics.query(req.params.id, opts);
  const summary = metrics.summary(req.params.id, since ? parseInt(since, 10) : undefined);
  res.json({ metrics: data, summary });
});

// Push plugin update
app.post('/api/kiosks/:id/update-plugin', (req, res) => {
  try {
    const { plugin, code } = req.body;
    if (!plugin || !code) return res.status(400).json({ error: 'plugin and code are required' });
    registry.pushUpdate(req.params.id, plugin, code);
    res.json({ success: true, message: `Plugin ${plugin} update pushed to ${req.params.id}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HTTP + WebSocket Server ───────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let kioskId = null;
  let authenticated = false;

  log(`New WebSocket connection from ${ip}`);

  // Auth timeout — must authenticate within 10s
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      log(`Auth timeout for connection from ${ip}`);
      ws.close(4001, 'Authentication timeout');
    }
  }, 10_000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    // ─── Authentication ─────────────────────────
    if (!authenticated) {
      if (msg.type === 'auth') {
        if (msg.token === HUB_TOKEN) {
          authenticated = true;
          kioskId = msg.kioskId;
          clearTimeout(authTimer);

          registry.register(kioskId, ws, {
            kioskName: msg.kioskName,
            ip,
            agentVersion: msg.agentVersion
          });

          ws.send(JSON.stringify({ type: 'auth-ok', message: 'Authenticated' }));
          log(`Kiosk authenticated: ${kioskId} from ${ip}`);
        } else {
          log(`Auth failed for ${ip} — bad token`);
          ws.close(4003, 'Invalid token');
        }
      } else {
        ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated. Send auth message first.' }));
      }
      return;
    }

    // ─── Authenticated messages ─────────────────
    switch (msg.type) {
      case 'heartbeat':
        registry.heartbeat(kioskId, msg.data);
        metrics.record(kioskId, msg.data);
        break;

      case 'response':
        registry.handleResponse(msg.requestId, msg);
        break;

      case 'event':
        log(`Event from ${kioskId}: ${msg.event} — ${JSON.stringify(msg.data || {})}`);
        // Could store events, trigger alerts, etc.
        break;

      default:
        log(`Unknown message type from ${kioskId}: ${msg.type}`);
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(authTimer);
    if (kioskId) {
      registry.disconnect(kioskId);
      log(`Kiosk ${kioskId} disconnected (code: ${code}, reason: ${reason || 'none'})`);
    }
  });

  ws.on('error', (err) => {
    log(`WebSocket error for ${kioskId || ip}: ${err.message}`);
  });

  // Ping every 30s to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30_000);

  ws.on('close', () => clearInterval(pingInterval));
});

// ─── Start ─────────────────────────────────────────────────────────

server.listen(PORT, () => {
  log(`Skynet Kiosk Hub running on port ${PORT}`);
  log(`REST API: http://localhost:${PORT}/api/kiosks`);
  log(`WebSocket: ws://localhost:${PORT}`);
});

function log(msg) {
  console.log(`[${new Date().toISOString()}] [Hub] ${msg}`);
}

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...');
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down...');
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});
