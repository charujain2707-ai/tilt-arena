// Tilt Arena – laptop side: WebSocket host + game loop
const $ = s => document.querySelector(s);
const cv = $('#cv'), ctx = cv.getContext('2d');
const WW = 1600, WH = 900, A = { x: 50, y: 50, w: 1500, h: 800 };
const R = 26, ACC = 1500, GRAV = 1500, WIN = 10;
const COLORS = ['#ff5d5d', '#4da3ff', '#ffd23f', '#7ae582', '#c77dff', '#ff9f1c', '#2ec4b6', '#f15bb5'];
const players = new Map();
let holes = [], stars = [], parts = [], banner = null, scale = 1, ox = 0, oy = 0;

// ---------- networking ----------
let ws, room = sessionStorage.room || '', retry = 0, hostLat = null, lastHpong = 0;
const send = m => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));

function connect() {
  setHost(false, 'Connecting…');
  const sock = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => { retry = 0; lastHpong = performance.now(); send({ t: 'host', room }); };
  ws.onmessage = e => {
    const m = JSON.parse(e.data), p = players.get(m.id);
    switch (m.t) {
      case 'room':
        room = m.room; sessionStorage.room = room; showRoom();
        players.forEach(q => { if (!m.players.some(x => x.id === q.id)) { q.online = false; q.offT = Date.now(); } });
        m.players.forEach(q => addPlayer(q.id, q.name)); break;
      case 'join': addPlayer(m.id, m.name); break;
      case 'leave': if (p) { p.online = false; p.offT = Date.now(); } renderList(); break;
      case 's': if (p) { p.tgt.x = m.x; p.tgt.y = m.y; if (!p.online) { p.online = true; renderList(); } } break;
      case 'a': if (p) action(p, m.a); break;
      case 'ping': send({ t: 'pong', to: m.id, c: m.c }); if (p && m.l != null) p.lat = m.l; break;
      case 'hpong': hostLat = Math.round(performance.now() - m.c); lastHpong = performance.now(); setHost(true); break;
    }
  };
  ws.onclose = () => { if (ws !== sock) return; setHost(false, 'Reconnecting…'); setTimeout(connect, Math.min(4000, 250 * 2 ** retry++)); };
}
// heartbeat: measure laptop↔server latency and force a reconnect if the link silently dies
setInterval(() => {
  if (ws?.readyState !== 1) return;
  if (performance.now() - lastHpong > 4000) return ws.close();
  send({ t: 'hping', c: performance.now() });
}, 1000);

function setHost(on, txt) {
  $('#hostLed').classList.toggle('on', on);
  $('#hostStatus').textContent = on ? `Server connected · ${hostLat ?? '–'} ms` : txt;
}
function showRoom() {
  const url = `${location.origin}/controller.html?room=${room}`;
  $('#code').textContent = $('#code2').textContent = room;
  $('#url').textContent = $('#url2').textContent = location.host + '/controller.html';
  const src = '/qr.svg?d=' + encodeURIComponent(url);
  $('#qrSmall').innerHTML = `<img src="${src}" width="120" height="120" alt="QR code to join">`;
  $('#qrBig').innerHTML = `<img src="${src}" width="260" height="260" alt="QR code to join">`;
}

// ---------- players ----------
function addPlayer(id, name) {
  let p = players.get(id);
  if (!p) {
    const used = new Set([...players.values()].map(q => q.color));
    p = { id, color: COLORS.find(c => !used.has(c)) || COLORS[players.size % 8], score: 0, in: { x: 0, y: 0 }, tgt: { x: 0, y: 0 }, lat: null, boostT: 0 };
    spawn(p); players.set(id, p);
  }
  p.name = name || p.name || 'Player'; p.online = true;
  info(p); renderList();
}
const info = p => send({ t: 'info', to: p.id, color: p.color, score: p.score, name: p.name });
const vib = (p, ms) => send({ t: 'vib', to: p.id, ms });

function renderList() {
  const arr = [...players.values()].sort((a, b) => b.score - a.score);
  $('#list').innerHTML = arr.length ? arr.map(p => `
    <div class="p ${p.online ? '' : 'off'}"><span class="c" style="background:${p.color}"></span>
      <span>${esc(p.name)}<br><span class="soft">${p.online ? (p.lat != null ? p.lat + ' ms' : 'connected') : 'reconnecting…'}</span></span><b>${p.score}</b></div>`).join('')
    : '<p class="soft">Waiting for phones…</p>';
  $('#join').classList.toggle('hide', arr.some(p => p.online));
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
setInterval(renderList, 500);

// ---------- game ----------
const rnd = (a, b) => a + Math.random() * (b - a);
function freeSpot(m) {
  for (let i = 0; i < 300; i++) {
    const x = rnd(A.x + m, A.x + A.w - m), y = rnd(A.y + m, A.y + A.h - m);
    if (holes.every(h => Math.hypot(h.x - x, h.y - y) > h.r + m + 15) && stars.every(s => Math.hypot(s.x - x, s.y - y) > 90)) return { x, y };
  }
  return { x: WW / 2, y: WH / 2 };
}
function spawn(p) { Object.assign(p, freeSpot(R + 25), { vx: 0, vy: 0, z: 0, vz: 0 }); }
function newRound() {
  holes = []; stars = []; banner = null;
  for (let i = 0; i < 6; i++) { const r = rnd(48, 72); holes.push({ ...freeSpot(r + 30), r }); }
  for (let i = 0; i < 3; i++) stars.push({ ...freeSpot(40), a: 0 });
  players.forEach(p => { p.score = 0; spawn(p); info(p); });
  renderList();
}
$('#newGame').onclick = newRound;

function action(p, a) {
  if (!p.online) return;
  if (a === 'jump' && p.z === 0) { p.vz = 580; vib(p, 25); }
  if (a === 'boost' && performance.now() - p.boostT > 1500) {
    p.boostT = performance.now();
    let dx = p.in.x, dy = p.in.y, m = Math.hypot(dx, dy);
    if (m < 0.1) { dx = p.vx; dy = p.vy; m = Math.hypot(dx, dy) || 1; }
    p.vx += dx / m * 750; p.vy += dy / m * 750;
    burst(p.x, p.y, p.color, 10); vib(p, 30);
  }
}
function burst(x, y, color, n = 16) {
  for (let i = 0; i < n; i++) { const a = rnd(0, 6.28), s = rnd(80, 340); parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, color }); }
}

function update(dt) {
  if (banner) { if (performance.now() > banner.until) newRound(); return; }
  for (const p of players.values()) {
    if (!p.online) { if (Date.now() - p.offT > 60000) { players.delete(p.id); renderList(); } continue; }
    const k = Math.min(1, dt * 30);                       // light smoothing of network input
    p.in.x += (p.tgt.x - p.in.x) * k; p.in.y += (p.tgt.y - p.in.y) * k;
    p.vx += p.in.x * ACC * dt; p.vy += p.in.y * ACC * dt;
    const f = Math.exp(-1.6 * dt); p.vx *= f; p.vy *= f;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.x < A.x + R) { p.x = A.x + R; p.vx = Math.abs(p.vx) * .6; }
    if (p.x > A.x + A.w - R) { p.x = A.x + A.w - R; p.vx = -Math.abs(p.vx) * .6; }
    if (p.y < A.y + R) { p.y = A.y + R; p.vy = Math.abs(p.vy) * .6; }
    if (p.y > A.y + A.h - R) { p.y = A.y + A.h - R; p.vy = -Math.abs(p.vy) * .6; }
    if (p.z > 0 || p.vz > 0) { p.vz -= GRAV * dt; p.z += p.vz * dt; if (p.z <= 0) { p.z = 0; p.vz = 0; } }
    if (p.z === 0 && holes.some(h => Math.hypot(p.x - h.x, p.y - h.y) < h.r - R * .3)) {
      burst(p.x, p.y, p.color, 22); p.score = Math.max(0, p.score - 1); vib(p, 350); spawn(p); info(p);
    }
    for (const s of stars) if (p.z < 70 && Math.hypot(p.x - s.x, p.y - s.y) < R + 22) {
      burst(s.x, s.y, '#ffc94a'); Object.assign(s, freeSpot(40)); p.score++; vib(p, 40); info(p);
      if (p.score >= WIN) {
        banner = { text: `${p.name} wins!`, color: p.color, until: performance.now() + 3500 };
        players.forEach(q => vib(q, q === p ? [120, 60, 120, 60, 300] : 250));
        return;
      }
    }
  }
  const on = [...players.values()].filter(p => p.online);   // ball-to-ball bumps
  for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
    const a = on[i], b = on[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (d > 0 && d < 2 * R && Math.abs(a.z - b.z) < 30) {
      const nx = dx / d, ny = dy / d, o = (2 * R - d) / 2;
      a.x -= nx * o; a.y -= ny * o; b.x += nx * o; b.y += ny * o;
      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vn < 0) { const j2 = vn * 1.1; a.vx += j2 * nx; a.vy += j2 * ny; b.vx -= j2 * nx; b.vy -= j2 * ny; }
    }
  }
  for (const s of stars) s.a += dt;
  parts.forEach(q => { q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= .94; q.vy *= .94; q.life -= dt * 1.6; });
  parts = parts.filter(q => q.life > 0);
}

// ---------- drawing ----------
function resize() {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
  cv.width = r.width * d; cv.height = r.height * d;
  scale = Math.min(cv.width / WW, cv.height / WH); ox = (cv.width - WW * scale) / 2; oy = (cv.height - WH * scale) / 2;
}
addEventListener('resize', resize);

function star(x, y, r, a) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * .45 : r, t = a + i * Math.PI / 5; ctx.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr); }
  ctx.closePath(); ctx.fill();
}
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#10201b'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  ctx.fillStyle = '#6b4428'; ctx.beginPath(); ctx.roundRect(A.x - 24, A.y - 24, A.w + 48, A.h + 48, 36); ctx.fill();
  ctx.fillStyle = '#1d6b57'; ctx.beginPath(); ctx.roundRect(A.x, A.y, A.w, A.h, 18); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 2;
  for (let x = A.x + 100; x < A.x + A.w; x += 100) { ctx.beginPath(); ctx.moveTo(x, A.y); ctx.lineTo(x, A.y + A.h); ctx.stroke(); }
  for (let y = A.y + 100; y < A.y + A.h; y += 100) { ctx.beginPath(); ctx.moveTo(A.x, y); ctx.lineTo(A.x + A.w, y); ctx.stroke(); }
  for (const h of holes) {
    const g = ctx.createRadialGradient(h.x, h.y - h.r * .2, 0, h.x, h.y, h.r);
    g.addColorStop(0, '#020a07'); g.addColorStop(.75, '#06140f'); g.addColorStop(1, '#0f3a2e');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 7); ctx.fill();
  }
  ctx.shadowColor = '#ffc94a'; ctx.shadowBlur = 18; ctx.fillStyle = '#ffc94a';
  for (const s of stars) star(s.x, s.y, 20 + Math.sin(s.a * 4) * 2, s.a);
  ctx.shadowBlur = 0;
  for (const p of [...players.values()].sort((a, b) => a.z - b.z)) {
    ctx.globalAlpha = p.online ? 1 : .3;
    const lift = p.z * .6, rr = R * (1 + p.z / 500);
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(p.x + p.z * .2, p.y + 6 + p.z * .15, R * (1 - p.z / 700), R * .7 * (1 - p.z / 700), 0, 0, 7); ctx.fill();
    const g = ctx.createRadialGradient(p.x - rr * .35, p.y - lift - rr * .35, 2, p.x, p.y - lift, rr);
    g.addColorStop(0, '#ffffff'); g.addColorStop(.25, p.color); g.addColorStop(1, shade(p.color));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y - lift, rr, 0, 7); ctx.fill();
    ctx.fillStyle = '#f3efe6'; ctx.font = '600 20px "IBM Plex Sans", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(p.name, p.x, p.y - lift - rr - 10);
  }
  ctx.globalAlpha = 1;
  for (const q of parts) { ctx.globalAlpha = Math.max(0, q.life); ctx.fillStyle = q.color; ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, 7); ctx.fill(); }
  ctx.globalAlpha = 1;
  if (banner) {
    ctx.fillStyle = 'rgba(16,32,27,.75)'; ctx.fillRect(A.x, WH / 2 - 90, A.w, 180);
    ctx.fillStyle = banner.color; ctx.font = '800 96px "Bricolage Grotesque", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(banner.text, WW / 2, WH / 2); ctx.textBaseline = 'alphabetic';
  }
}
function shade(hex) { const n = parseInt(hex.slice(1), 16); return `rgb(${(n >> 16) * .45 | 0},${(n >> 8 & 255) * .45 | 0},${(n & 255) * .45 | 0})`; }

let last = performance.now();
function frame(t) { update(Math.min(.033, (t - last) / 1000)); last = t; draw(); requestAnimationFrame(frame); }
resize(); newRound(); connect(); requestAnimationFrame(frame);
