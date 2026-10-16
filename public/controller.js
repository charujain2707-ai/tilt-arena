// Tilt Arena – phone controller: reads motion sensors and streams them over WebSockets
const $ = s => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const id = localStorage.pid || (localStorage.pid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
$('#room').value = (qs.get('room') || localStorage.room || '').toUpperCase();
$('#name').value = localStorage.pname || '';
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

let rtimer, ws, room, name, retry = 0, fatal = false, lastPong = 0, lat = null, hostOn = false;
const raw = { b: 0, g: 0 }, zero = { b: 0, g: 0 };
let joinedOnce = false, started = false, gotSensor = false, shakeT = 0, sent = { x: 9, y: 9, t: 0 }, tilt = { x: 0, y: 0 };
const RANGE = 22;          // degrees of tilt for full speed
const DEAD = 0.04;         // dead-zone so a still phone gives a still ball

// ---------- start (needs a tap: iOS only grants sensor access inside a user gesture) ----------
$('#start').onclick = async () => {
  room = $('#room').value.trim().toUpperCase(); name = $('#name').value.trim() || 'Player';
  if (!/^[A-Z0-9]{4}$/.test(room)) return ($('#err').textContent = 'Enter the 4-character code from the laptop.');
  try {
    if (typeof DeviceMotionEvent?.requestPermission === 'function') {
      if (await DeviceMotionEvent.requestPermission() !== 'granted') throw 0;
      await DeviceOrientationEvent.requestPermission();
    }
  } catch { return ($('#err').textContent = 'Motion access was denied. Allow it and try again.'); }
  localStorage.room = room; localStorage.pname = name;
  $('#setup').classList.add('hide'); $('#pad').classList.remove('hide');
  document.documentElement.requestFullscreen?.().then(() => screen.orientation?.lock?.('portrait')).catch(() => {});
  keepAwake();
  if (!started) {
    started = true;
    addEventListener('deviceorientation', onOrient);
    addEventListener('devicemotion', onMotion);
    requestAnimationFrame(loop);
  }
  setTimeout(calibrate, 400);
  setTimeout(() => { if (!gotSensor) $('#sensor').textContent = 'No sensor data. Open this page over https and allow motion access.'; }, 2500);
  if (room !== localStorage.lastRoom) joinedOnce = false;
  localStorage.lastRoom = room; fatal = false; retry = 0; connect();
};

// ---------- sensors ----------
function onOrient(e) {           // orientation = gyroscope + accelerometer fused by the phone
  if (e.beta == null) return;
  gotSensor = true; raw.b = e.beta; raw.g = e.gamma;
}
function onMotion(e) {           // accelerometer for shake, gyroscope rate for the readout
  const a = e.acceleration, ag = e.accelerationIncludingGravity, now = performance.now();
  const mag = a && a.x != null ? Math.hypot(a.x, a.y, a.z) : ag ? Math.abs(Math.hypot(ag.x, ag.y, ag.z) - 9.81) : 0;
  if (mag > 13 && now - shakeT > 600) { shakeT = now; act('jump', $('#jump')); }
  const r = e.rotationRate;
  onMotion.gyro = r ? Math.round(Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0)) : null;
}
function calibrate() { zero.b = raw.b; zero.g = raw.g; navigator.vibrate?.(30); }
$('#cal').onclick = calibrate;

const clamp = v => Math.max(-1, Math.min(1, v));
const shape = v => Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD);

// ---------- main loop: send at display rate, only fresh data ----------
function loop() {
  tilt.x = shape(clamp((raw.g - zero.g) / RANGE));
  tilt.y = shape(clamp((raw.b - zero.b) / RANGE));
  const maxPx = $('.level').clientWidth / 2 - 23;
  $('#bubble').style.transform = `translate(${tilt.x * maxPx}px,${tilt.y * maxPx}px)`;
  if (gotSensor) $('#sensor').textContent = `tilt ${tilt.x.toFixed(2)}, ${tilt.y.toFixed(2)} · gyro ${onMotion.gyro ?? '–'}°/s`;
  const now = performance.now();
  const changed = Math.abs(tilt.x - sent.x) > .005 || Math.abs(tilt.y - sent.y) > .005;
  // skip frames if the socket is backed up: stale input is worse than dropped input
  if (ws?.readyState === 1 && ws.bufferedAmount < 512 && (changed || now - sent.t > 200)) {
    ws.send(`{"t":"s","x":${tilt.x.toFixed(3)},"y":${tilt.y.toFixed(3)}}`);
    sent = { x: tilt.x, y: tilt.y, t: now };
  }
  requestAnimationFrame(loop);
}

// ---------- buttons ----------
function act(a, btn) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'a', a }));
  btn.classList.add('hit'); setTimeout(() => btn.classList.remove('hit'), 120);
}
for (const [el, a] of [[$('#jump'), 'jump'], [$('#boost'), 'boost']])
  el.addEventListener('pointerdown', e => { e.preventDefault(); act(a, el); });

// ---------- connection with automatic reconnect ----------
function setStatus(state) {
  const map = { connecting: ['wait', 'Connecting…'], reconnecting: ['wait', 'Reconnecting…'], nohost: ['wait', 'Waiting for the laptop…'], online: ['on', `Connected to room ${room}`] };
  const [cls, txt] = map[state];
  $('#led').className = 'led ' + cls; $('#stat').textContent = txt;
}
function connect() {
  setStatus(retry ? 'reconnecting' : 'connecting');
  clearTimeout(rtimer);
  const sock = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => { retry = 0; lastPong = performance.now(); ws.send(JSON.stringify({ t: 'join', room, id, name })); };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'joined') { joinedOnce = true; hostOn = m.host; setStatus(hostOn ? 'online' : 'nohost'); }
    else if (m.t === 'host') { hostOn = m.on; setStatus(m.on ? 'online' : 'nohost'); }
    else if (m.t === 'pong') {
      lastPong = performance.now();
      if (!m.nohost) { lat = Math.round(lastPong - m.c); $('#lat').textContent = `${lat} ms to laptop`; if (!hostOn) { hostOn = true; setStatus('online'); } }
    }
    else if (m.t === 'vib') navigator.vibrate?.(m.ms);
    else if (m.t === 'info') {
      document.documentElement.style.setProperty('--me', m.color);
      $('#who').textContent = m.name; $('#score').textContent = m.score;
    }
    else if (m.t === 'err' && m.code === 'noroom' && joinedOnce) {
      setStatus('nohost'); retry = 2; ws.close(); // server restarted; laptop will recreate the room, keep retrying
    }
    else if (m.t === 'err') {
      fatal = true; ws.close();
      $('#pad').classList.add('hide'); $('#setup').classList.remove('hide'); $('#err').textContent = m.msg;
    }
  };
  ws.onclose = () => {             // only the newest socket may schedule a reconnect
    if (fatal || ws !== sock) return;
    setStatus('reconnecting'); rtimer = setTimeout(connect, Math.min(4000, 250 * 2 ** retry++));
  };
}
// ping every second through the server to the laptop and back = true end-to-end latency
setInterval(() => {
  if (ws?.readyState !== 1) return;
  if (performance.now() - lastPong > 4000) return ws.close();   // silent drop → reconnect
  ws.send(JSON.stringify({ t: 'ping', c: performance.now(), l: lat }));
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !room || fatal) return;
  keepAwake();
  if (!ws || ws.readyState > 1) { retry = 0; connect(); }
});

let lock;
async function keepAwake() { try { lock = await navigator.wakeLock?.request('screen'); } catch {} }
