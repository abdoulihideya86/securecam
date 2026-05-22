/**
 * SecureCam - Shared Client Library
 * WebRTC + WebSocket + Motion Detection + Notifications
 */

'use strict';

// ─── WebSocket Manager ────────────────────────────────────
class SignalingClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this._pingInterval = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._maxDelay = 16000;
    this._intentionalClose = false;
  }

  connect() {
    this._intentionalClose = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    console.log('[WS] Connecting to', url);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.connected = true;
      this._reconnectDelay = 1000;
      this._startPing();
      this.dispatchEvent(new Event('open'));
    };

    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'pong') return;
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._stopPing();
      this.dispatchEvent(new Event('close'));
      if (!this._intentionalClose) this._scheduleReconnect();
    };

    this.ws.onerror = () => { this.ws.close(); };
  }

  send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    this._stopPing();
    if (this.ws) this.ws.close();
  }

  _startPing() {
    this._pingInterval = setInterval(() => this.send({ type: 'ping' }), 25000);
  }

  _stopPing() {
    clearInterval(this._pingInterval);
  }

  _scheduleReconnect() {
    console.log(`[WS] Reconnecting in ${this._reconnectDelay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
      this.connect();
    }, this._reconnectDelay);
  }
}

// ─── WebRTC Peer Manager ──────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

class PeerCamera extends EventTarget {
  constructor(signaling, viewerId) {
    super();
    this.signaling = signaling;
    this.viewerId = viewerId;
    this.pc = new RTCPeerConnection(ICE_SERVERS);
    this._setup();
  }

  _setup() {
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.send({
          type: 'ice-candidate',
          candidate: e.candidate,
          targetId: this.viewerId
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log(`[PC→${this.viewerId}]`, this.pc.connectionState);
      this.dispatchEvent(new CustomEvent('statechange', { detail: this.pc.connectionState }));
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') {
        this.pc.restartIce();
      }
    };
  }

  async addStream(stream) {
    stream.getTracks().forEach(track => this.pc.addTrack(track, stream));
  }

  async createOffer() {
    const offer = await this.pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await this.pc.setLocalDescription(offer);
    this.signaling.send({ type: 'offer', sdp: offer, targetId: this.viewerId });
  }

  async handleAnswer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async handleIce(candidate) {
    try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  }

  close() { this.pc.close(); }
}

class PeerViewer extends EventTarget {
  constructor(signaling) {
    super();
    this.signaling = signaling;
    this.pc = new RTCPeerConnection(ICE_SERVERS);
    this._setup();
  }

  _setup() {
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.send({ type: 'ice-candidate', candidate: e.candidate });
      }
    };

    this.pc.ontrack = (e) => {
      this.dispatchEvent(new CustomEvent('stream', { detail: e.streams[0] }));
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[PeerViewer]', this.pc.connectionState);
      this.dispatchEvent(new CustomEvent('statechange', { detail: this.pc.connectionState }));
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.pc.restartIce();
    };
  }

  async handleOffer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.send({ type: 'answer', sdp: answer });
  }

  async handleIce(candidate) {
    try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  }

  close() { this.pc.close(); }
}

// ─── Motion Detector ─────────────────────────────────────
class MotionDetector extends EventTarget {
  constructor(options = {}) {
    super();
    this.threshold = options.threshold || 25;      // pixel diff threshold (0-255)
    this.sensitivity = options.sensitivity || 0.015; // fraction of pixels that must differ
    this.cooldown = options.cooldown || 3000;       // ms between events
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._prevData = null;
    this._lastEvent = 0;
    this._active = false;
    this._animFrame = null;
  }

  start(videoEl, overlayCanvas) {
    this._video = videoEl;
    this._overlay = overlayCanvas;
    this._overlayCtx = overlayCanvas?.getContext('2d');
    this._active = true;
    this._loop();
  }

  stop() {
    this._active = false;
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
  }

  setThreshold(v) { this.threshold = v; }
  setSensitivity(v) { this.sensitivity = v; }

  _loop() {
    if (!this._active) return;
    this._analyze();
    this._animFrame = requestAnimationFrame(() => {
      setTimeout(() => this._loop(), 100); // ~10fps for motion check
    });
  }

  _analyze() {
    const video = this._video;
    if (!video || video.readyState < 2) return;

    const w = video.videoWidth || 320;
    const h = video.videoHeight || 240;
    if (this._canvas.width !== w) this._canvas.width = w;
    if (this._canvas.height !== h) this._canvas.height = h;

    this._ctx.drawImage(video, 0, 0, w, h);
    const frame = this._ctx.getImageData(0, 0, w, h);
    const data = frame.data;

    if (!this._prevData) {
      this._prevData = new Uint8ClampedArray(data);
      return;
    }

    let diffCount = 0;
    const total = (w * h);

    for (let i = 0; i < data.length; i += 4) {
      const dr = Math.abs(data[i]   - this._prevData[i]);
      const dg = Math.abs(data[i+1] - this._prevData[i+1]);
      const db = Math.abs(data[i+2] - this._prevData[i+2]);
      if ((dr + dg + db) / 3 > this.threshold) diffCount++;
    }

    this._prevData = new Uint8ClampedArray(data);

    const fraction = diffCount / total;
    const now = Date.now();

    if (fraction > this.sensitivity && (now - this._lastEvent) > this.cooldown) {
      this._lastEvent = now;
      const snapshot = this._canvas.toDataURL('image/jpeg', 0.6);
      this.dispatchEvent(new CustomEvent('motion', {
        detail: { fraction: Math.round(fraction * 1000) / 10, snapshot }
      }));
    }
  }
}

// ─── Notification Manager ─────────────────────────────────
class NotificationManager {
  constructor() {
    this.supported = 'Notification' in window;
    this.permission = this.supported ? Notification.permission : 'denied';
  }

  async requestPermission() {
    if (!this.supported) return false;
    const result = await Notification.requestPermission();
    this.permission = result;
    return result === 'granted';
  }

  notify(title, body, icon) {
    if (this.permission !== 'granted') return;
    const n = new Notification(title, {
      body,
      icon: icon || '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'motion-alert',
      renotify: true,
      requireInteraction: false
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 6000);
  }
}

// ─── QR Code Generator (simple) ──────────────────────────
// Using a lightweight inline implementation
function generateQRSVG(text) {
  // Returns a link to a QR generation service — no external lib needed
  const encoded = encodeURIComponent(text);
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encoded}&bgcolor=0d1117&color=00e5ff&margin=10`;
}

// ─── Exports ──────────────────────────────────────────────
window.SecureCam = {
  SignalingClient,
  PeerCamera,
  PeerViewer,
  MotionDetector,
  NotificationManager,
  generateQRSVG
};
