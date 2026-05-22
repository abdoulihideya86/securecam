/**
 * SecureCam - Signaling & Alert Server
 * Node.js + Express + WebSocket
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── State ───────────────────────────────────────────────
const rooms = new Map();
// rooms: { [code]: { camera: ws|null, viewers: Set<ws>, events: [], created: Date } }

const clientMeta = new WeakMap();
// clientMeta: ws → { role, roomCode, id }

// ─── Helpers ─────────────────────────────────────────────
function generateCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A3F9C1"
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { camera: null, viewers: new Set(), events: [], created: new Date() });
  }
  return rooms.get(code);
}

function cleanupClient(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.roomCode);
  if (!room) return;

  if (meta.role === 'camera') {
    room.camera = null;
    // Notify all viewers camera disconnected
    room.viewers.forEach(v => send(v, { type: 'camera-disconnected' }));
    console.log(`[${meta.roomCode}] Camera disconnected`);
  } else if (meta.role === 'viewer') {
    room.viewers.delete(ws);
    if (room.camera) send(room.camera, { type: 'viewer-left', id: meta.id });
    console.log(`[${meta.roomCode}] Viewer left`);
  }

  // Cleanup empty rooms after 30min
  if (!room.camera && room.viewers.size === 0) {
    setTimeout(() => {
      const r = rooms.get(meta.roomCode);
      if (r && !r.camera && r.viewers.size === 0) {
        rooms.delete(meta.roomCode);
        console.log(`[${meta.roomCode}] Room cleaned up`);
      }
    }, 30 * 60 * 1000);
  }
}

// ─── WebSocket Handler ────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('New WS connection');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const meta = clientMeta.get(ws);

    // ── JOIN as camera ──
    if (msg.type === 'join-camera') {
      const code = msg.code || generateCode();
      const room = getOrCreateRoom(code);

      if (room.camera && room.camera !== ws) {
        send(ws, { type: 'error', message: 'Room already has a camera' });
        return;
      }

      room.camera = ws;
      clientMeta.set(ws, { role: 'camera', roomCode: code, id: 'camera' });
      send(ws, { type: 'joined', role: 'camera', code });
      console.log(`[${code}] Camera joined`);

      // Notify existing viewers
      room.viewers.forEach(v => send(v, { type: 'camera-ready' }));
    }

    // ── JOIN as viewer ──
    else if (msg.type === 'join-viewer') {
      const code = msg.code;
      if (!code || !rooms.has(code)) {
        send(ws, { type: 'error', message: 'Invalid pairing code' });
        return;
      }
      const room = rooms.get(code);
      const id = crypto.randomBytes(2).toString('hex');
      room.viewers.add(ws);
      clientMeta.set(ws, { role: 'viewer', roomCode: code, id });
      send(ws, { type: 'joined', role: 'viewer', code, cameraOnline: !!room.camera });
      send(ws, { type: 'events-history', events: room.events.slice(-20) });
      console.log(`[${code}] Viewer joined (id: ${id})`);

      // Tell camera about new viewer
      if (room.camera) send(room.camera, { type: 'viewer-joined', id });
    }

    // ── WebRTC Signaling ──
    else if (msg.type === 'offer') {
      // Camera → Viewer
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      const target = [...room.viewers].find(v => clientMeta.get(v)?.id === msg.targetId);
      if (target) send(target, { type: 'offer', sdp: msg.sdp, fromId: 'camera' });
    }

    else if (msg.type === 'answer') {
      // Viewer → Camera
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room || !room.camera) return;
      send(room.camera, { type: 'answer', sdp: msg.sdp, fromId: meta.id });
    }

    else if (msg.type === 'ice-candidate') {
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      if (meta.role === 'camera') {
        // Forward to specific viewer or all
        const target = msg.targetId
          ? [...room.viewers].find(v => clientMeta.get(v)?.id === msg.targetId)
          : null;
        if (target) send(target, { type: 'ice-candidate', candidate: msg.candidate, fromId: 'camera' });
      } else {
        if (room.camera) send(room.camera, { type: 'ice-candidate', candidate: msg.candidate, fromId: meta.id });
      }
    }

    // ── Motion Event ──
    else if (msg.type === 'motion-event') {
      if (!meta || meta.role !== 'camera') return;
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      const event = {
        id: crypto.randomBytes(4).toString('hex'),
        timestamp: new Date().toISOString(),
        snapshot: msg.snapshot || null,
        level: msg.level || 'medium'
      };
      room.events.push(event);
      if (room.events.length > 100) room.events.shift();

      // Broadcast to all viewers
      room.viewers.forEach(v => send(v, { type: 'motion-alert', event }));
      console.log(`[${meta.roomCode}] Motion detected!`);
    }

    // ── Ping/Pong keepalive ──
    else if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
    }
  });

  ws.on('close', () => cleanupClient(ws));
  ws.on('error', () => cleanupClient(ws));
});

// ─── REST API ─────────────────────────────────────────────
app.post('/api/create-room', (req, res) => {
  const code = generateCode();
  getOrCreateRoom(code);
  res.json({ code });
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    cameraOnline: !!room.camera,
    viewers: room.viewers.size,
    events: room.events.length,
    created: room.created
  });
});

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// ─── Routes ──────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/camera', (req, res) => res.sendFile(path.join(__dirname, '../public/camera.html')));
app.get('/viewer', (req, res) => res.sendFile(path.join(__dirname, '../public/viewer.html')));

// ─── Start ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🔒 SecureCam Server running on http://localhost:${PORT}`);
  console.log(`📷 Camera:  http://localhost:${PORT}/camera`);
  console.log(`📱 Viewer:  http://localhost:${PORT}/viewer\n`);
});
