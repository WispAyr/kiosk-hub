# Skynet Kiosk Management System

Remote management system for Windows kiosk displays. Consists of a **Hub** (runs on PU2) and **Agents** (run on each Windows kiosk).

> **GitHub:** [WispAyr/skynet-kiosk](https://github.com/WispAyr/skynet-kiosk)

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Hub Setup (PU2)](#hub-setup-pu2)
- [Agent Setup (Windows Kiosks)](#agent-setup-windows-kiosks)
- [API Reference](#api-reference)
- [Plugin System](#plugin-system)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        PROCESSING UNIT TWO                      │
│                        192.168.195.33                            │
│                                                                 │
│  ┌──────────────┐     ┌──────────────────┐     ┌────────────┐  │
│  │ Skynet       │────▶│ Kiosk Hub        │◀────│ Signage    │  │
│  │ (Clawdbot)   │ REST│ :3750            │     │ Server     │  │
│  │              │ API │ - WS Server      │     │ :3400      │  │
│  └──────────────┘     │ - REST API       │     └────────────┘  │
│                       │ - Registry       │                      │
│                       │ - Metrics Store  │                      │
│                       └──────┬───────────┘                      │
│                              │ WebSocket (outbound from agents) │
└──────────────────────────────┼──────────────────────────────────┘
                               │
                    ┌──────────┼──────────┐
              ZeroTier / LAN   │          │
                    │          │          │
         ┌─────────▼──┐ ┌─────▼──────┐ ┌─▼───────────┐
         │ pavilion-1  │ │ pavilion-2 │ │ pavilion-3   │
         │ Windows 10  │ │ Windows 10 │ │ Windows 10   │
         │ Agent       │ │ Agent      │ │ Agent        │
         │ + Chrome    │ │ + Chrome   │ │ + Chrome     │
         │   (kiosk)   │ │   (kiosk)  │ │   (kiosk)    │
         └─────────────┘ └────────────┘ └──────────────┘
```

### Key Design Decisions

1. **Outbound WebSocket** — Agents connect TO the hub, not the other way around. This means:
   - No port forwarding needed on the kiosk network
   - Works through NAT, firewalls, Starlink, mobile data
   - Hub just needs to be reachable (it is, via ZeroTier)

2. **Plugin Architecture** — Agent capabilities are modular JS files. New features can be:
   - Pushed remotely from the hub (OTA updates)
   - Hot-reloaded without restarting the agent
   - Added by dropping a `.js` file in the `plugins/` directory

3. **Self-Healing** — Agent auto-reconnects with exponential backoff (1s → 60s max). Runs as a Windows scheduled task under SYSTEM, starts on boot, restarts on failure.

---

## Hub Setup (PU2)

The hub is already deployed and running on PU2.

### Location
```
/Users/noc/operations/kiosk-hub/
```

### PM2 Process
```bash
pm2 start ecosystem.config.cjs    # Start
pm2 restart kiosk-hub              # Restart
pm2 logs kiosk-hub                 # View logs
pm2 stop kiosk-hub                 # Stop
```

### Configuration

Environment variables (set in `ecosystem.config.cjs`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3750` | HTTP + WebSocket port |
| `HUB_TOKEN` | `skynet-kiosk-token-2025` | Shared secret for agent auth |

### Dependencies
- `ws` — WebSocket server
- `express` — REST API
- `cors` — Cross-origin support
- `uuid` — Request ID generation

### Files
```
kiosk-hub/
├── hub.js                 # Main entry — WS server + REST API
├── ecosystem.config.cjs   # PM2 config
├── package.json
└── lib/
    ├── registry.js        # Kiosk state management, command routing
    └── metrics.js         # Rolling 24h metrics store
```

### Health Check
```bash
curl http://localhost:3750/health
# {"status":"ok","service":"kiosk-hub","uptime":12345}
```

---

## Agent Setup (Windows Kiosks)

### Prerequisites
- Windows 10 or 11
- Network access to PU2 (via ZeroTier or local LAN)
- Administrator access (for installation)

### Quick Install

1. **Copy the agent folder** to the Windows kiosk:
   ```
   # From PU2, or download from GitHub
   # Copy /Users/noc/operations/kiosk-agent/ to the kiosk
   # e.g., to C:\SkynetAgent\
   ```

2. **Run the installer** (as Administrator):
   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

3. **Follow the prompts:**
   ```
   Enter Kiosk ID (e.g., pavilion-1): pavilion-1
   Enter Kiosk Name [Pavilion 1]: Pavilion Screen 1
   Hub WebSocket URL [ws://192.168.195.33:3750]: <Enter>
   ```

4. **Done.** The agent auto-starts and connects to the hub.

### What the Installer Does

1. **Checks/installs Node.js** — Downloads Node.js 20 LTS if not present
2. **Prompts for configuration** — Kiosk ID, name, hub URL
3. **Creates `config.json`** — Writes the agent configuration
4. **Runs `npm install`** — Installs dependencies (ws, systeminformation)
5. **Creates Windows Scheduled Task** — `SkynetKioskAgent` runs as SYSTEM on boot
6. **Starts the agent** immediately

### Manual Install (Alternative)

If the installer doesn't suit your needs:

```powershell
# 1. Install Node.js from https://nodejs.org

# 2. Navigate to agent folder
cd C:\SkynetAgent

# 3. Install dependencies
npm install --production

# 4. Edit config.json
notepad config.json

# 5. Test it
node agent.js

# 6. Set up auto-start however you prefer (Task Scheduler, NSSM, PM2, etc.)
```

### Agent Configuration (`config.json`)

```json
{
  "kioskId": "pavilion-1",
  "kioskName": "Pavilion Screen 1",
  "hubUrl": "ws://192.168.195.33:3750",
  "hubToken": "skynet-kiosk-token-2025",
  "heartbeatInterval": 30000,
  "browserPath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "defaultUrl": "http://192.168.195.33:3400/pavilion/promo-carousel.html",
  "kioskMode": true
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `kioskId` | ✅ | Unique identifier (e.g., `pavilion-1`, `pavilion-2`) |
| `kioskName` | ✅ | Human-readable name |
| `hubUrl` | ✅ | WebSocket URL of the hub |
| `hubToken` | ✅ | Shared authentication token |
| `heartbeatInterval` | | Metrics send interval in ms (default: 30000) |
| `browserPath` | | Path to Chrome/Edge executable |
| `defaultUrl` | | URL to display on startup |
| `kioskMode` | | Launch browser in kiosk mode (default: true) |

### Agent Files
```
kiosk-agent/
├── agent.js          # Main entry — WS client, plugin loader
├── config.json       # Configuration (created by installer)
├── install.ps1       # Windows installer script
├── package.json
└── plugins/
    ├── heartbeat.js  # System metrics collection
    ├── screenshot.js # Screen capture
    ├── browser.js    # Chrome/Edge kiosk control
    ├── shell.js      # Shell/PowerShell execution
    ├── system.js     # Reboot, shutdown, display control
    └── updater.js    # OTA updates, hot-reload
```

### Managing the Agent on Windows

```powershell
# Check if running
Get-ScheduledTask -TaskName 'SkynetKioskAgent'

# Stop
Stop-ScheduledTask -TaskName 'SkynetKioskAgent'

# Start
Start-ScheduledTask -TaskName 'SkynetKioskAgent'

# Uninstall
Unregister-ScheduledTask -TaskName 'SkynetKioskAgent' -Confirm:$false
```

---

## API Reference

All endpoints are on the hub at `http://localhost:3750` (or `http://192.168.195.33:3750` from other machines).

### List All Kiosks
```
GET /api/kiosks
```
Returns array of all known kiosks with their current state.

**Response:**
```json
[
  {
    "kioskId": "pavilion-1",
    "kioskName": "Pavilion Screen 1",
    "status": "online",
    "connected": true,
    "connectedAt": 1707900000000,
    "lastHeartbeat": 1707900030000,
    "lastSeen": 1707900030000,
    "ip": "192.168.195.100",
    "metrics": {
      "cpu": 12,
      "ram": 65,
      "disk": 43,
      "hostname": "PAVILION-1",
      "uptime": 86400
    }
  }
]
```

Status values: `online` | `offline` | `stale` (no heartbeat for 90s)

### Get Single Kiosk
```
GET /api/kiosks/:id
```

### Take Screenshot
```
GET /api/kiosks/:id/screenshot
```
Returns PNG image directly (Content-Type: image/png). Timeout: 15 seconds.

**Example:**
```bash
curl http://localhost:3750/api/kiosks/pavilion-1/screenshot -o screenshot.png
```

### Navigate Browser
```
POST /api/kiosks/:id/browser/navigate
Content-Type: application/json

{"url": "http://192.168.195.33:3400/pavilion/countdown.html"}
```
Kills existing browser, relaunches with new URL in kiosk mode.

### Refresh Browser
```
POST /api/kiosks/:id/browser/refresh
```
Sends F5 to the active window. Falls back to browser restart if F5 fails.

### Reboot Kiosk
```
POST /api/kiosks/:id/reboot
Content-Type: application/json

{"delay": 5}
```
Schedules a Windows reboot (default: 5 second delay).

### Execute Shell Command
```
POST /api/kiosks/:id/shell
Content-Type: application/json

{
  "command": "Get-Process | Select -First 5",
  "powershell": true,
  "timeout": 30000
}
```
Executes a shell command (PowerShell by default). Returns stdout, stderr, exit code.

**Response:**
```json
{
  "success": true,
  "stdout": "Handles  NPM(K)  ...",
  "stderr": "",
  "exitCode": 0,
  "command": "Get-Process | Select -First 5",
  "powershell": true
}
```

### Generic Command
```
POST /api/kiosks/:id/command
Content-Type: application/json

{
  "plugin": "system",
  "action": "info",
  "data": {},
  "timeout": 30000
}
```
Send any command to any plugin. This is the universal endpoint.

### Broadcast to All Kiosks
```
POST /api/kiosks/broadcast
Content-Type: application/json

{
  "plugin": "browser",
  "action": "navigate",
  "data": {"url": "http://192.168.195.33:3400/pavilion/countdown.html"}
}
```
Sends the same command to ALL connected kiosks. Returns per-kiosk results.

### Get Metrics History
```
GET /api/kiosks/:id/metrics?since=1707900000000&limit=100
```
Returns historical metrics (rolling 24h window, 30s intervals = ~2880 data points).

**Response:**
```json
{
  "metrics": [
    {"cpu": 12, "ram": 65, "disk": 43, "timestamp": 1707900000000},
    {"cpu": 15, "ram": 66, "disk": 43, "timestamp": 1707900030000}
  ],
  "summary": {
    "count": 120,
    "period": {"from": 1707900000000, "to": 1707903600000},
    "cpu": {"avg": 14, "min": 8, "max": 45},
    "ram": {"avg": 64, "min": 60, "max": 72}
  }
}
```

### Push Plugin Update
```
POST /api/kiosks/:id/update-plugin
Content-Type: application/json

{
  "plugin": "custom-feature",
  "code": "export default { async init(ctx) { ... }, async handleCommand(action, data) { ... } };"
}
```
Pushes new plugin code to a kiosk. The agent writes the file and hot-reloads it.

---

## Plugin System

### How Plugins Work

Each plugin is a standalone ES module in the `plugins/` directory. Plugins are loaded on agent startup and can be hot-reloaded at runtime.

### Plugin Interface

Every plugin must export:

```javascript
export default {
  // Called once on load — receives agent context
  async init(ctx) {
    // ctx.config  — agent config.json
    // ctx.send    — function to send messages to hub
    // ctx.log     — logger function
  },

  // Called when hub sends a command targeting this plugin
  async handleCommand(action, data) {
    // action — string (e.g., 'capture', 'navigate', 'exec')
    // data   — object with command parameters
    // Return value is sent back to hub as response
    return { success: true, result: '...' };
  },

  // Optional: called when plugin is being unloaded/replaced
  async destroy() {
    // Cleanup resources
  }
};
```

### Built-in Plugins

| Plugin | Actions | Description |
|--------|---------|-------------|
| `heartbeat` | `collect` | Gathers CPU, RAM, disk, network, OS info via `systeminformation` |
| `screenshot` | `capture` | Captures screen via PowerShell .NET (fallback: nircmd) |
| `browser` | `navigate`, `refresh`, `restart`, `launch`, `kill`, `status` | Controls Chrome/Edge in kiosk mode |
| `shell` | `exec`, `powershell` | Runs arbitrary commands, returns stdout/stderr/exitCode |
| `system` | `reboot`, `shutdown`, `info`, `lock`, `display-off`, `display-on` | System power and display control |
| `updater` | `update-plugin`, `list-plugins`, `get-plugin`, `self-update`, `restart` | OTA updates and agent management |

### Creating Custom Plugins

Create a new `.js` file in the `plugins/` directory:

```javascript
// plugins/content-scheduler.js
let log;
let config;

export default {
  async init(ctx) {
    log = ctx.log;
    config = ctx.config;
    log('Content scheduler initialized');
  },

  async handleCommand(action, data) {
    switch (action) {
      case 'set-schedule':
        // Schedule URL changes based on time
        return { success: true, schedule: data };
      case 'get-schedule':
        return { schedule: currentSchedule };
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
};
```

Push it remotely:
```bash
curl -X POST http://localhost:3750/api/kiosks/pavilion-1/update-plugin \
  -H "Content-Type: application/json" \
  -d '{"plugin": "content-scheduler", "code": "export default { ... }"}'
```

Or drop the file in `plugins/` and restart the agent.

---

## Security

### Authentication
- Agents authenticate with a shared token (`hubToken` in config)
- The hub rejects connections that don't authenticate within 10 seconds
- Token is configured via `HUB_TOKEN` environment variable on the hub

### Network
- Agents connect outbound only — no listening ports on kiosks
- Communication over ZeroTier (encrypted WireGuard tunnel)
- Hub only listens on the ZeroTier interface (192.168.195.33)

### Shell Access
- The `shell` plugin allows arbitrary command execution on kiosks
- This is intentional — it's the "further access" escape hatch
- Only accessible via the hub API (which runs on PU2)

### Recommendations
- Change the default token before deploying to production
- Consider adding per-kiosk tokens if needed
- The hub has no authentication on its REST API — it trusts localhost/ZeroTier
- To add API auth, add a middleware to `hub.js` (Bearer token check)

---

## Troubleshooting

### Agent won't connect
1. Check ZeroTier is running: `zerotier-cli status`
2. Check hub is reachable: `ping 192.168.195.33`
3. Check hub port: `Test-NetConnection -ComputerName 192.168.195.33 -Port 3750`
4. Check agent logs: `Get-Content C:\SkynetAgent\agent.log` (or check Task Scheduler history)
5. Verify `config.json` has correct `hubUrl` and `hubToken`

### Agent shows as "stale" on hub
- Agent hasn't sent a heartbeat in 90+ seconds
- Could be network issue, agent crash, or kiosk asleep
- Check: `curl http://localhost:3750/api/kiosks/pavilion-1`

### Screenshot fails
- Requires a desktop session (even if locked)
- Scheduled task runs as SYSTEM — may need to enable "Allow service to interact with desktop"
- Fallback: install [nircmd](https://www.nirsoft.net/utils/nircmd.html) on the kiosk

### Browser won't launch
- Verify `browserPath` in config.json points to the correct Chrome/Edge path
- Common paths:
  - Chrome: `C:\Program Files\Google\Chrome\Application\chrome.exe`
  - Edge: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- Check if browser is already running: use `browser.status` action

### Hub not responding
```bash
pm2 logs kiosk-hub --lines 20   # Check logs
pm2 restart kiosk-hub           # Restart
curl http://localhost:3750/health  # Health check
```

---

## Skynet Integration

Skynet (Clawdbot) controls kiosks via the hub REST API. Example commands:

```bash
# "Show countdown on all screens"
curl -X POST http://localhost:3750/api/kiosks/broadcast \
  -H "Content-Type: application/json" \
  -d '{"plugin":"browser","action":"navigate","data":{"url":"http://192.168.195.33:3400/pavilion/countdown.html"}}'

# "Screenshot pavilion 2"
curl http://localhost:3750/api/kiosks/pavilion-2/screenshot -o /tmp/pav2.png

# "Reboot pavilion 3"
curl -X POST http://localhost:3750/api/kiosks/pavilion-3/reboot

# "What's running on pavilion 1?"
curl -X POST http://localhost:3750/api/kiosks/pavilion-1/shell \
  -H "Content-Type: application/json" \
  -d '{"command":"Get-Process chrome | Select ProcessName,Id,CPU,WorkingSet"}'
```

---

## Message Protocol

Communication between agent and hub uses JSON over WebSocket.

### Agent → Hub

| Type | When | Data |
|------|------|------|
| `auth` | On connect | `{kioskId, kioskName, token, agentVersion}` |
| `heartbeat` | Every 30s | `{cpu, ram, disk, hostname, uptime, ips, ...}` |
| `response` | After command | `{requestId, data}` or `{requestId, error}` |
| `event` | On notable events | `{event: "browser-crashed", data: {...}}` |

### Hub → Agent

| Type | When | Data |
|------|------|------|
| `auth-ok` | Auth success | `{message}` |
| `command` | API request | `{requestId, plugin, action, data}` |
| `update` | Plugin push | `{plugin, code}` |
| `error` | On errors | `{error: "message"}` |

---

## Deployment Checklist (Per Kiosk)

- [ ] Windows 10/11 machine powered on
- [ ] ZeroTier installed and joined to network `b15644912edba5c9`
- [ ] ZeroTier member approved (check: `curl -H "Authorization: bearer AhLfqFfYEjudj1EryB5lzaHlXa5W52sa" https://api.zerotier.com/api/v1/network/b15644912edba5c9/member`)
- [ ] Can ping `192.168.195.33` from kiosk
- [ ] Agent folder copied to kiosk (e.g., `C:\SkynetAgent\`)
- [ ] `install.ps1` run as Administrator
- [ ] Kiosk appears in hub: `curl http://localhost:3750/api/kiosks`
- [ ] Screenshot works: `curl http://localhost:3750/api/kiosks/{id}/screenshot -o test.png`
- [ ] Browser navigates correctly
- [ ] Chrome installed and path correct in config.json

---

*Last updated: 2026-02-14*
*Version: 1.0.0*
