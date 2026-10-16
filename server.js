// Tilt Arena server: serves the game + controller and relays WebSocket messages between phone and laptop.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const QR = require('qrcode');

const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/qr.svg') { // QR code for pairing, generated on the server (no CDN needed)
    return QR.toString(u.searchParams.get('d') || '', { type: 'svg', margin: 1 }, (err, svg) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'image/svg+xml' }); res.end(svg || '');
    });
  }
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// perMessageDeflate off = no compression delay on tiny sensor packets
const wss = new WebSocketServer({ server, perMessageDeflate: false });
const rooms = new Map(); // code -> { code, host, players: Map(id -> ws), hostTimer }
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c; do c = Array.from({ length: 4 }, () => CHARS[Math.random() * CHARS.length | 0]).join(''); while (rooms.has(c)); return c; };
const send = (ws, m) => ws && ws.readyState === 1 && ws.send(typeof m === 'string' ? m : JSON.stringify(m));

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  if (ws._socket) ws._socket.setNoDelay(true); // disable Nagle buffering

  ws.on('message', buf => {
    const raw = buf.toString(); let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'host') { // laptop creates a room, or resumes its old code after a reconnect
      let r = rooms.get(m.room);
      if (!r) {
        const code = /^[A-Z0-9]{4}$/.test(m.room || '') ? m.room : newCode();
        r = { code, host: null, players: new Map() }; rooms.set(code, r);
      }
      clearTimeout(r.hostTimer);
      if (r.host && r.host !== ws) r.host.close();
      r.host = ws; ws.role = 'host'; ws.room = r;
      send(ws, { t: 'room', room: r.code, players: [...r.players.values()].map(p => ({ id: p.pid, name: p.pname })) });
      r.players.forEach(p => send(p, { t: 'host', on: true }));
      return;
    }

    if (m.t === 'join') { // phone joins with room code
      const r = rooms.get(String(m.room || '').toUpperCase().trim());
      if (!r) return send(ws, { t: 'err', code: 'noroom', msg: 'Room not found. Check the code on the laptop screen.' });
      const old = r.players.get(m.id);
      if (!old && r.players.size >= 8) return send(ws, { t: 'err', msg: 'Room is full (8 players max).' });
      if (old && old !== ws) old.close();
      ws.role = 'player'; ws.room = r; ws.pid = String(m.id); ws.pname = String(m.name || 'Player').slice(0, 12);
      r.players.set(ws.pid, ws);
      send(ws, { t: 'joined', room: r.code, host: !!r.host });
      send(r.host, { t: 'join', id: ws.pid, name: ws.pname });
      return;
    }

    const r = ws.room; if (!r) return;
    if (ws.role === 'host') {
      if (m.t === 'hping') return send(ws, { t: 'hpong', c: m.c });
      if (m.to) send(r.players.get(m.to), raw);
      return;
    }
    if (ws.role === 'player') {
      if (!r.host) { if (m.t === 'ping') send(ws, { t: 'pong', c: m.c, nohost: 1 }); return; }
      m.id = ws.pid;
      send(r.host, m);
    }
  });

  ws.on('close', () => {
    const r = ws.room; if (!r) return;
    if (ws.role === 'host' && r.host === ws) {
      r.host = null;
      r.players.forEach(p => send(p, { t: 'host', on: false }));
      r.hostTimer = setTimeout(() => { if (!r.host) { r.players.forEach(p => p.close()); rooms.delete(r.code); } }, 10 * 60000);
    }
    if (ws.role === 'player' && r.players.get(ws.pid) === ws) {
      r.players.delete(ws.pid);
      send(r.host, { t: 'leave', id: ws.pid });
    }
  });
});

// drop dead connections so clients reconnect quickly
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 15000);

server.listen(PORT, () => console.log(`Tilt Arena running on http://localhost:${PORT}`));
