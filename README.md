# 🔒 SecureCam — Browser-Based Home Security System

Turn any two smartphones into a surveillance system using only a browser. No apps, no accounts, no subscriptions.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     SIGNALING SERVER                          │
│               Node.js + Express + WebSocket                   │
│  • Generates pairing codes (6-char hex rooms)                │
│  • Routes WebRTC SDP offer/answer between devices            │
│  • Forwards ICE candidates                                    │
│  • Broadcasts motion events to all viewers                   │
│  • Stores last 100 events per room in memory                 │
└──────────────┬───────────────────────────┬───────────────────┘
               │ WSS (signaling only)       │ WSS
    ┌──────────▼──────────┐     ┌──────────▼──────────┐
    │   📷 CAMERA DEVICE   │     │   📱 VIEWER DEVICE   │
    │   /camera            │     │   /viewer            │
    │                      │     │                      │
    │  getUserMedia API     │     │  RTCPeerConnection   │
    │  Canvas motion diff   │◄────│  Live video playback │
    │  MediaRecorder        │     │  Push notifications  │
    │  Wake Lock API        │     │  Snapshot viewer     │
    └──────────────────────┘     └──────────────────────┘
           ▲         WebRTC P2P (direct, encrypted)          ▲
           └─────────────────────────────────────────────────┘
                        Video stream (SRTP)
```

### Data Flow
1. Camera joins → Server assigns 6-char code
2. Viewer enters code → Server validates and connects them
3. Server relays WebRTC handshake (offer/answer/ICE)
4. WebRTC P2P connection established — video flows directly device-to-device
5. Motion events → Camera → Server → All Viewers (via WebSocket)

---

## 📦 Project Structure

```
securecam/
├── server/
│   └── index.js          # Node.js signaling + alert server
├── public/
│   ├── index.html        # Landing page
│   ├── camera.html       # Camera device UI
│   ├── viewer.html       # Viewer device UI
│   └── securecam.js      # Shared client library
├── package.json
└── README.md
```

---

## 🚀 Setup Guide

### Prerequisites
- Node.js 18+ installed
- Two devices on any network (or internet via ngrok)

### 1. Install & Run Locally

```bash
# Clone or copy the project
cd securecam

# Install dependencies
npm install

# Start the server
npm start
# → Server running at http://localhost:3000
```

### 2. Access on Same WiFi

| Device | URL |
|--------|-----|
| Camera | `http://YOUR_LOCAL_IP:3000/camera` |
| Viewer | `http://YOUR_LOCAL_IP:3000/viewer` |

Find your local IP:
```bash
# macOS/Linux
ifconfig | grep "inet "
# Windows
ipconfig
```

### 3. Access Over the Internet (ngrok)

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
# → Forwarding: https://abc123.ngrok.io

# Use HTTPS URL for both devices
# Camera: https://abc123.ngrok.io/camera
# Viewer: https://abc123.ngrok.io/viewer
```

**⚠️ HTTPS is required** for camera access on mobile browsers.

---

## 📱 Pairing Instructions

### Step 1 — Camera Device
1. Open `/camera` on Device A
2. A **6-character code** (e.g. `A3F9C1`) appears automatically
3. Optionally tap **⊞** for a QR code, or **⎘** to copy the code

### Step 2 — Viewer Device
1. Open `/viewer` on Device B
2. Enter the 6-character code
3. Tap **CONNECT**
4. Tap **▶ START STREAM** on the camera device

### Step 3 — Enable Motion Detection
1. On camera device, tap **▶ START STREAM** first
2. Then tap **👁 MOTION ON**
3. Adjust sensitivity slider as needed (4 is a good default)

---

## ⚙️ Configuration

### Motion Detection Tuning

| Sensitivity | Best For |
|-------------|----------|
| 1–2 | Busy areas, pets, frequent movement |
| 3–5 | Indoor home monitoring (default) |
| 6–8 | Quiet rooms, entrances |
| 9–10 | Maximum sensitivity, outdoor |

The motion detector compares frames at 10fps using pixel-by-pixel difference analysis. When `(changed pixels / total pixels) > sensitivity threshold`, a motion event fires.

### Environment Variables

```bash
PORT=3000          # Server port (default: 3000)
```

---

## 🌐 Production Deployment

### Deploy to Railway / Render / Fly.io

```bash
# Railway
npm install -g @railway/cli
railway login
railway init
railway up

# Render — connect GitHub repo, set:
# Build: npm install
# Start: npm start
```

### Deploy to VPS (Ubuntu)

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 for process management
npm install -g pm2

# Clone project and start
cd securecam && npm install
pm2 start server/index.js --name securecam
pm2 startup && pm2 save

# NGINX reverse proxy + SSL (certbot)
# Point domain → localhost:3000
```

### Nginx Config (with SSL)

```nginx
server {
    listen 443 ssl;
    server_name yourcam.example.com;

    ssl_certificate /etc/letsencrypt/live/yourcam.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourcam.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

---

## 🔐 Security Model

| Threat | Mitigation |
|--------|-----------|
| Unauthorized stream access | 6-char random pairing codes; only paired devices receive the WebRTC offer |
| Stream interception | WebRTC uses SRTP (encrypted by default) |
| Signal interception | WSS (WebSocket over TLS) in production |
| Code brute-force | 16.7M possible codes; server can add rate limiting |
| Public stream exposure | No stream ever touches the server — P2P only |

### Hardening Checklist
- [ ] Always use HTTPS/WSS in production (required for camera API anyway)
- [ ] Add rate limiting to `/api/create-room` (e.g. `express-rate-limit`)
- [ ] Set `Content-Security-Policy` headers
- [ ] Rotate pairing codes after session ends
- [ ] Add optional PIN on top of pairing code for extra security

---

## 🔔 Notifications

The viewer page uses the **Web Notifications API**:
1. Tap the **NOTIFY** toggle on the viewer
2. Accept the browser permission prompt
3. Notifications fire automatically when motion is detected
4. Each notification includes time and can show a snapshot

**Limitations**: Background notifications work best on desktop. On iOS Safari, web notifications have limited support — the device must have the app "Added to Home Screen" and be running iOS 16.4+.

---

## 📹 Recording

When motion is detected on the camera device:
- **MediaRecorder** captures a 10-second clip in WebM format
- Clip auto-downloads to the camera device
- A **REC** badge appears during recording

To save to cloud, modify the `recorder.onstop` handler in `camera.html` to upload to Firebase Storage or S3.

---

## 🐛 Troubleshooting

| Problem | Solution |
|---------|----------|
| Camera not loading | Grant camera permission; use HTTPS |
| "Invalid pairing code" | Check code is exactly 6 chars; camera must be online first |
| Video freezes | Check network stability; WebRTC will auto-reconnect ICE |
| No motion alerts | Enable motion detection after starting stream |
| iOS camera not working | Use Safari on iOS; Chrome on iOS doesn't support getUserMedia fully |
| Black screen on viewer | Tap START STREAM on camera first, then connect viewer |

### STUN Server Fallback

If devices are on strict NAT (corporate networks), WebRTC peer connection may fail. Add TURN server credentials to `ICE_SERVERS` in `securecam.js`:

```javascript
{ urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' }
```

Free TURN servers: Metered.ca, Xirsys, or self-host Coturn.

---

## 🔮 Future Features

- [ ] **Multiple cameras** — already architecture-ready (viewer-per-peer model)
- [ ] **Cloud clip storage** — Firebase Storage or S3 upload on motion
- [ ] **Telegram bot alerts** — POST snapshot to Bot API on motion event
- [ ] **Two-way audio** — add `audio: true` to getUserMedia + renegotiate
- [ ] **Playback timeline** — store events in SQLite, serve clips from storage
- [ ] **PIN protection** — add PIN input step after code entry
- [ ] **Night mode AI** — TensorFlow.js person detection vs simple pixel diff

---

## 📄 License

Personal use. No warranty. Use responsibly and only monitor spaces you own or have explicit permission to monitor.
