#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

let webpush;
try { webpush = require('web-push'); }
catch { console.error('\n  Run npm install first\n'); process.exit(1); }

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const KEYS_FILE = path.join(__dirname, 'vapid-keys.json');

// VAPID keys: env vars on Railway, local file in dev
let VAPID_PUBLIC, VAPID_PRIVATE;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
  VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
} else {
  let keys;
  if (fs.existsSync(KEYS_FILE)) {
    keys = JSON.parse(fs.readFileSync(KEYS_FILE));
  } else {
    keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys));
  }
  VAPID_PUBLIC = keys.publicKey;
  VAPID_PRIVATE = keys.privateKey;
}
webpush.setVapidDetails('mailto:baby@monitor.local', VAPID_PUBLIC, VAPID_PRIVATE);

// ── Rooms ─────────────────────────────────────────────────────────────────────
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 (confusing)
  return Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
}

function createRoom() {
  let code;
  do { code = generateCode(); } while (rooms.has(code));
  rooms.set(code, {
    sseClients: [],
    pushSubs: new Map(),
    lastVolume: 0,
    crying: false,
    cryTimer: null,
    lastPushAt: 0,
    threshold: 25,
  });
  return code;
}

function getRoom(code) {
  return rooms.get((code || '').toUpperCase().trim());
}

function broadcastRoom(room, payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  room.sseClients = room.sseClients.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

async function pushRoom(room, code) {
  if (!room.pushSubs.size) return;
  const now = Date.now();
  if (now - room.lastPushAt < 30_000) return;
  room.lastPushAt = now;
  const payload = JSON.stringify({ body: '🍼 Your baby is crying!', code });
  const dead = [];
  for (const [ep, sub] of room.pushSubs) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(ep); }
  }
  dead.forEach(ep => room.pushSubs.delete(ep));
}

function onRoomVolume(room, code, vol) {
  room.lastVolume = Math.max(0, Math.min(100, vol));
  broadcastRoom(room, { volume: room.lastVolume });
  if (room.lastVolume >= room.threshold && !room.crying) {
    room.crying = true;
    clearTimeout(room.cryTimer);
    pushRoom(room, code).catch(() => {});
  } else if (room.lastVolume < room.threshold) {
    clearTimeout(room.cryTimer);
    room.cryTimer = setTimeout(() => { room.crying = false; }, 2500);
  }
}

// ── PWA assets ────────────────────────────────────────────────────────────────
const SW_JS = `'use strict';
self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : { body: 'Your baby is crying!', code: '' };
  e.waitUntil(self.registration.showNotification('Baby Monitor 👶', {
    body: d.body, tag: 'baby-cry', renotify: true, requireInteraction: true,
    vibrate: [300,100,300,100,500], data: { code: d.code },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.code ? '/parent?code=' + e.notification.data.code : '/';
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true })
      .then(ws => { for (const w of ws) if ('focus' in w) return w.focus(); return clients.openWindow(url); })
  );
});`;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="20" fill="#0f0f1a"/>
<text x="50" y="70" font-size="60" text-anchor="middle" font-family="system-ui,sans-serif">👶</text></svg>`;

const MANIFEST = JSON.stringify({
  name: 'Baby Monitor', short_name: 'Baby Monitor',
  start_url: '/', display: 'standalone',
  background_color: '#0f0f1a', theme_color: '#0f0f1a',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
});

// ── Shared CSS vars ───────────────────────────────────────────────────────────
const BASE_CSS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0f0f1a;--card:#16162a;--green:#2ecc71;--red:#e74c3c;--amber:#f39c12;
    --muted:rgba(255,255,255,.45);--border:rgba(255,255,255,.1)}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:var(--bg);color:#fff;min-height:100dvh}
  input,button{font-family:inherit}
`;

// ── Landing page ──────────────────────────────────────────────────────────────
const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<title>Baby Monitor</title>
<style>
${BASE_CSS}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:0}
.logo{font-size:4rem;margin-bottom:12px;line-height:1}
h1{font-size:1.6rem;font-weight:700;margin-bottom:4px}
.tagline{font-size:.85rem;color:var(--muted);margin-bottom:32px}
.card{width:100%;max-width:340px;background:var(--card);border:1px solid var(--border);
  border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:20px}
.section-label{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.role-toggle{display:flex;gap:8px}
.role-btn{flex:1;padding:12px 8px;border:1.5px solid var(--border);border-radius:10px;
  background:transparent;color:rgba(255,255,255,.6);font-size:.88rem;cursor:pointer;
  transition:all .15s;display:flex;flex-direction:column;align-items:center;gap:5px;line-height:1.2}
.role-btn .icon{font-size:1.8rem}
.role-btn:hover{border-color:rgba(255,255,255,.3);color:#fff}
.role-btn.active{border-color:var(--green);background:rgba(46,204,113,.1);color:#fff}
.divider{display:flex;align-items:center;gap:10px;font-size:.75rem;color:var(--muted)}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
.big-btn{width:100%;padding:14px;background:var(--green);border:none;border-radius:12px;
  color:#0f0f1a;font-size:1rem;font-weight:700;cursor:pointer;transition:opacity .15s}
.big-btn:hover{opacity:.88}
.big-btn:active{opacity:.78;transform:scale(.99)}
.join-row{display:flex;gap:8px}
.code-input{flex:1;padding:12px 14px;background:rgba(255,255,255,.06);border:1.5px solid var(--border);
  border-radius:10px;color:#fff;font-size:1.1rem;font-family:monospace;letter-spacing:.12em;
  text-transform:uppercase;outline:none;transition:border-color .15s;min-width:0}
.code-input::placeholder{text-transform:none;letter-spacing:0;font-size:.9rem;color:var(--muted);font-family:-apple-system,sans-serif}
.code-input:focus{border-color:rgba(255,255,255,.4)}
.join-btn{padding:12px 16px;background:rgba(255,255,255,.08);border:1.5px solid var(--border);
  border-radius:10px;color:#fff;font-size:.9rem;cursor:pointer;white-space:nowrap;transition:background .15s}
.join-btn:hover{background:rgba(255,255,255,.15)}
.error{min-height:1.2em;font-size:.8rem;color:var(--red);text-align:center;padding-top:6px}
</style>
</head>
<body>
<div class="logo">👶</div>
<h1>Baby Monitor</h1>
<p class="tagline">Keep an ear on your little one</p>

<div class="card">
  <div>
    <div class="section-label">I am the…</div>
    <div class="role-toggle">
      <button class="role-btn active" id="babyBtn" onclick="setRole('baby')">
        <span class="icon">🎤</span>Baby side
      </button>
      <button class="role-btn" id="parentBtn" onclick="setRole('parent')">
        <span class="icon">📱</span>Parent
      </button>
    </div>
  </div>

  <button class="big-btn" onclick="createRoom()">Create new room</button>

  <div class="divider">or join existing</div>

  <div>
    <div class="join-row">
      <input class="code-input" type="text" id="codeInput" placeholder="Room code" maxlength="6" autocomplete="off" autocorrect="off" spellcheck="false">
      <button class="join-btn" onclick="joinRoom()">Join →</button>
    </div>
    <div class="error" id="error"></div>
  </div>
</div>

<script>
'use strict';
let role = 'baby';

function setRole(r) {
  role = r;
  document.getElementById('babyBtn').classList.toggle('active', r === 'baby');
  document.getElementById('parentBtn').classList.toggle('active', r === 'parent');
}

const codeInput = document.getElementById('codeInput');
codeInput.addEventListener('input', function() {
  this.value = this.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
  document.getElementById('error').textContent = '';
});
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

async function createRoom() {
  try {
    const res = await fetch('/create', { method: 'POST' });
    const { code } = await res.json();
    location.href = '/' + role + '?code=' + code;
  } catch {
    document.getElementById('error').textContent = 'Could not create room. Try again.';
  }
}

async function joinRoom() {
  const code = codeInput.value.trim();
  if (code.length < 4) { document.getElementById('error').textContent = 'Enter a room code.'; return; }
  try {
    const res = await fetch('/check?code=' + code);
    const { exists } = await res.json();
    if (!exists) { document.getElementById('error').textContent = 'Room not found. Check the code and try again.'; return; }
    location.href = '/' + role + '?code=' + code;
  } catch {
    document.getElementById('error').textContent = 'Could not connect. Try again.';
  }
}
</script>
</body>
</html>`;

// ── Baby page ─────────────────────────────────────────────────────────────────
function buildBabyHTML(code) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Baby Monitor — Mic</title>
<style>
${BASE_CSS}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px 24px 80px}
.top-bar{position:fixed;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;
  padding:12px 16px;background:rgba(15,15,26,.9);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--border);font-size:.82rem;z-index:10}
.room-code{font-family:monospace;font-size:.95rem;letter-spacing:.1em;color:#fff;display:flex;align-items:center;gap:8px}
.copy-btn{padding:3px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;
  color:var(--muted);font-size:.72rem;cursor:pointer;transition:all .15s}
.copy-btn:hover{border-color:rgba(255,255,255,.3);color:#fff}
.home-link{color:var(--muted);text-decoration:none;font-size:.78rem}
.home-link:hover{color:#fff}
h1{font-size:1rem;font-weight:600;letter-spacing:.08em;opacity:.55;margin-top:8px}
.mic-btn{width:130px;height:130px;border-radius:50%;border:2.5px solid rgba(255,255,255,.2);
  background:rgba(255,255,255,.04);cursor:pointer;font-size:3.5rem;
  display:flex;align-items:center;justify-content:center;transition:all .2s ease;user-select:none}
.mic-btn:active{transform:scale(.94)}
.mic-btn.on{border-color:var(--red);background:rgba(231,76,60,.12)}
.mic-btn.on.loud{background:rgba(231,76,60,.3);box-shadow:0 0 50px rgba(231,76,60,.55)}
.status{font-size:.88rem;color:var(--muted);min-height:1.4em;text-align:center}
.meter-wrap{width:100%;max-width:280px}
.meter-lbl{display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted);margin-bottom:6px}
.meter-track{height:12px;background:rgba(255,255,255,.07);border-radius:6px;overflow:hidden;position:relative}
.meter-fill{height:100%;width:0%;border-radius:6px;
  background:linear-gradient(90deg,var(--green) 0%,var(--amber) 55%,var(--red) 100%);transition:width .08s linear}
.thresh-mark{position:absolute;top:0;bottom:0;width:2px;background:rgba(255,255,255,.5);pointer-events:none}
.controls{width:100%;max-width:280px;display:flex;flex-direction:column;gap:6px}
.ctrl-lbl{font-size:.78rem;color:var(--muted);display:flex;justify-content:space-between}
input[type=range]{width:100%;accent-color:var(--red)}
.alert-banner{display:none;width:100%;max-width:280px;padding:11px 16px;
  background:var(--red);border-radius:10px;font-weight:700;text-align:center}
.alert-banner.show{display:block}

/* Wake lock guide */
.wake-section{width:100%;max-width:280px}
.wake-row{display:flex;align-items:center;gap:8px;font-size:.78rem;color:var(--muted);margin-bottom:8px}
.wake-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--muted)}
.wake-guide{background:rgba(255,255,255,.05);border:1px solid var(--border);
  border-radius:10px;padding:12px 14px;font-size:.78rem;color:var(--muted);line-height:1.65}
.wake-guide strong{color:rgba(255,255,255,.8)}
.wake-guide ul{padding-left:1.1em;margin-top:6px}
.wake-guide li{margin-bottom:3px}
.wake-toggle{background:none;border:none;color:var(--muted);font-size:.75rem;cursor:pointer;
  text-decoration:underline;padding:0;margin-left:auto}
</style>
</head>
<body>

<div class="top-bar">
  <div class="room-code">
    Room <strong>${code}</strong>
    <button class="copy-btn" onclick="copyCode()">Copy</button>
  </div>
  <a class="home-link" href="/">← New room</a>
</div>

<h1>BABY MONITOR — MIC</h1>
<button class="mic-btn" id="btn" onclick="toggle()">🎤</button>
<div class="status" id="status">Click to start listening</div>

<div class="meter-wrap">
  <div class="meter-lbl"><span>Volume</span><span id="pct">0%</span></div>
  <div class="meter-track">
    <div class="meter-fill" id="fill"></div>
    <div class="thresh-mark" id="mark" style="left:30%"></div>
  </div>
</div>

<div class="controls">
  <div class="ctrl-lbl"><span>Alert threshold</span><span id="threshVal">30%</span></div>
  <input type="range" id="threshSlider" min="5" max="80" value="30">
</div>

<div class="alert-banner" id="banner">⚠️ LOUD — alert sent to parent</div>

<div class="wake-section">
  <div class="wake-row">
    <div class="wake-dot" id="wakeDot"></div>
    <span id="wakeText">Checking screen lock…</span>
    <button class="wake-toggle" id="wakeToggle" style="display:none" onclick="toggleGuide()">How to fix</button>
  </div>
  <div class="wake-guide" id="wakeGuide" style="display:none">
    <strong>Keeping the screen on:</strong>
    <ul>
      <li><strong>Best:</strong> Add to Home Screen (Share → Add to Home Screen) — enables automatic screen wake lock</li>
      <li><strong>iPhone:</strong> Settings → Display &amp; Brightness → Auto-Lock → <em>Never</em></li>
      <li><strong>Android:</strong> Settings → Display → Screen timeout → longest option</li>
      <li>Plug into power — prevents screen from dimming</li>
      <li>Remember to restore Auto-Lock when done!</li>
    </ul>
  </div>
</div>

<script>
'use strict';
const CODE = '${code}';
const btn=document.getElementById('btn'),status=document.getElementById('status');
const fill=document.getElementById('fill'),pct=document.getElementById('pct');
const mark=document.getElementById('mark');
const threshSlider=document.getElementById('threshSlider'),threshVal=document.getElementById('threshVal');
const banner=document.getElementById('banner');
const wakeDot=document.getElementById('wakeDot'),wakeText=document.getElementById('wakeText');
const wakeToggle=document.getElementById('wakeToggle'),wakeGuide=document.getElementById('wakeGuide');

let ctx=null,analyser=null,stream=null,running=false;
let threshold=30,smoothed=0,lastPost=0,wakeLock=null,guideOpen=false;

function copyCode(){
  navigator.clipboard?.writeText(CODE).catch(()=>{});
  const btn=document.querySelector('.copy-btn');
  btn.textContent='Copied!';
  setTimeout(()=>btn.textContent='Copy',1500);
}

function toggleGuide(){
  guideOpen=!guideOpen;
  wakeGuide.style.display=guideOpen?'block':'none';
  wakeToggle.textContent=guideOpen?'Hide':'How to fix';
}

threshSlider.oninput=()=>{
  threshold=+threshSlider.value;
  threshVal.textContent=threshold+'%';
  mark.style.left=threshold+'%';
};

async function toggle(){running?stop():await start();}

async function start(){
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    ctx=new(window.AudioContext||window.webkitAudioContext)();
    const src=ctx.createMediaStreamSource(stream);
    analyser=ctx.createAnalyser();
    analyser.fftSize=1024;
    src.connect(analyser);
    running=true;
    btn.classList.add('on');
    btn.textContent='🔴';
    status.textContent='Listening…';
    acquireWakeLock();
    requestAnimationFrame(tick);
  }catch(e){
    status.textContent=e.name==='NotAllowedError'?'Mic permission denied':'Could not access mic';
  }
}

function stop(){
  running=false;
  stream?.getTracks().forEach(t=>t.stop());
  ctx?.close();
  wakeLock?.release();
  btn.classList.remove('on','loud');
  btn.textContent='🎤';
  status.textContent='Click to start listening';
  fill.style.width='0%'; pct.textContent='0%';
  banner.classList.remove('show');
  send(0);
}

function tick(){
  if(!running)return;
  const data=new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatTimeDomainData(data);
  let sum=0; for(const s of data) sum+=s*s;
  const rms=Math.sqrt(sum/data.length);
  smoothed=smoothed*.55+rms*.45;
  const v=Math.min(100,Math.round(smoothed*500));
  fill.style.width=v+'%'; pct.textContent=v+'%';
  const loud=v>=threshold;
  banner.classList.toggle('show',loud);
  btn.classList.toggle('loud',loud);
  const now=performance.now();
  if(now-lastPost>=150){send(v);lastPost=now;}
  requestAnimationFrame(tick);
}

function send(volume){
  fetch('/volume?code='+CODE,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({volume}),keepalive:true}).catch(()=>{});
}

async function acquireWakeLock(){
  if(!navigator.wakeLock){
    wakeText.textContent='Screen may sleep — see how to fix';
    wakeDot.style.background='var(--amber)';
    wakeToggle.style.display='inline';
    return;
  }
  try{
    wakeLock=await navigator.wakeLock.request('screen');
    wakeText.textContent='Screen stays on automatically ✓';
    wakeDot.style.background='var(--green)';
    wakeLock.addEventListener('release',()=>{
      wakeText.textContent='Screen lock released — may sleep';
      wakeDot.style.background='var(--amber)';
      wakeToggle.style.display='inline';
    });
  }catch{
    wakeText.textContent='Screen may sleep — see how to fix';
    wakeDot.style.background='var(--amber)';
    wakeToggle.style.display='inline';
  }
}

document.addEventListener('visibilitychange',()=>{
  if(running&&document.visibilityState==='visible') acquireWakeLock();
});
</script>
</body>
</html>`;
}

// ── Parent page ───────────────────────────────────────────────────────────────
function buildParentHTML(code) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<title>Baby Monitor</title>
<style>
${BASE_CSS}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:24px;padding:24px 24px 80px;transition:background .35s ease}
body.cry{background:#1c0404}
.top-bar{position:fixed;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;
  padding:12px 16px;background:rgba(15,15,26,.9);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--border);font-size:.82rem;z-index:10}
.room-code{font-family:monospace;font-size:.95rem;letter-spacing:.1em;display:flex;align-items:center;gap:8px}
.copy-btn{padding:3px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;
  color:var(--muted);font-size:.72rem;cursor:pointer;transition:all .15s}
.copy-btn:hover{border-color:rgba(255,255,255,.3);color:#fff}
.conn{display:flex;align-items:center;gap:6px;font-size:.7rem;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green)}
.dot.off{background:var(--red);animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
.home-link{color:var(--muted);text-decoration:none;font-size:.78rem}
.home-link:hover{color:#fff}
.orb{width:160px;height:160px;border-radius:50%;border:3px solid var(--green);
  background:rgba(46,204,113,.1);display:flex;align-items:center;justify-content:center;
  font-size:4.5rem;transition:all .3s ease;box-shadow:0 0 40px rgba(46,204,113,.18);margin-top:8px}
.orb.cry{border-color:var(--red);background:rgba(231,76,60,.15);
  box-shadow:0 0 70px rgba(231,76,60,.5);animation:throb .55s ease-in-out infinite alternate}
@keyframes throb{from{transform:scale(1)}to{transform:scale(1.07)}}
.big-label{font-size:1.9rem;font-weight:700;letter-spacing:.02em;transition:color .3s}
.big-label.cry{color:var(--red)}
.sub{font-size:.82rem;color:var(--muted);margin-top:-16px}
.meter-wrap{width:100%;max-width:300px}
.meter-lbl{display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted);margin-bottom:6px}
.meter-track{height:14px;background:rgba(255,255,255,.07);border-radius:7px;overflow:hidden;position:relative}
.meter-fill{height:100%;width:0%;border-radius:7px;
  background:linear-gradient(90deg,var(--green) 0%,var(--amber) 55%,var(--red) 100%);transition:width .15s linear}
.thresh-line{position:absolute;top:0;bottom:0;width:2px;background:rgba(255,255,255,.55);pointer-events:none}
.panel{width:100%;max-width:300px;display:flex;flex-direction:column;gap:14px}
.ctrl-lbl{font-size:.78rem;color:var(--muted);display:flex;justify-content:space-between}
input[type=range]{width:100%;accent-color:var(--red)}
.btns{display:flex;gap:10px}
button.action{flex:1;padding:10px 14px;border:1.5px solid var(--border);border-radius:10px;
  background:rgba(255,255,255,.05);color:#fff;font-size:.82rem;cursor:pointer;transition:background .15s}
button.action:hover,button.action:active{background:rgba(255,255,255,.12)}
button.action.push-on{border-color:var(--green);color:var(--green)}
button.action.muted{border-color:var(--red);color:var(--red)}
.setup-box{padding:14px 16px;border-radius:12px;background:rgba(255,255,255,.04);
  border:1px solid var(--border);font-size:.78rem;color:var(--muted);line-height:1.7}
.setup-box strong{color:rgba(255,255,255,.8)}
.setup-box ol{padding-left:1.1em;margin-top:4px}
.last-alert{font-size:.72rem;color:var(--muted);min-height:1.2em}
</style>
</head>
<body id="body">

<div class="top-bar">
  <div class="room-code">
    Room <strong>${code}</strong>
    <button class="copy-btn" onclick="copyCode()">Copy</button>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <div class="conn"><div class="dot" id="dot"></div><span id="connLbl">Connecting…</span></div>
    <a class="home-link" href="/">← New room</a>
  </div>
</div>

<div class="orb" id="orb">😴</div>
<div class="big-label" id="lbl">All Quiet</div>
<div class="sub">Monitoring baby</div>

<div class="meter-wrap">
  <div class="meter-lbl"><span>Baby volume</span><span id="pct">0%</span></div>
  <div class="meter-track">
    <div class="meter-fill" id="fill"></div>
    <div class="thresh-line" id="tline" style="left:25%"></div>
  </div>
</div>

<div class="panel">
  <div>
    <div class="ctrl-lbl"><span>Alert threshold</span><span id="threshVal">25%</span></div>
    <input type="range" id="threshSlider" min="5" max="80" value="25">
  </div>
  <div class="btns">
    <button class="action" id="muteBtn" onclick="toggleMute()">🔔 Sound on</button>
    <button class="action" onclick="testAlert()">▶ Test sound</button>
  </div>
  <button class="action" id="pushBtn" onclick="enablePush()">🔔 Enable push alerts</button>
  <div class="setup-box" id="setupBox">
    <strong>Get notified when phone is sleeping:</strong>
    <ol>
      <li>Open this page in <strong>Safari</strong> on your iPhone</li>
      <li>Tap <strong>Share → Add to Home Screen</strong></li>
      <li>Open the app from your Home Screen</li>
      <li>Tap <strong>Enable push alerts</strong> above &amp; allow notifications</li>
    </ol>
  </div>
  <div class="last-alert" id="lastAlert"></div>
</div>

<script>
'use strict';
const CODE = '${code}';
const VAPID_KEY = '${VAPID_PUBLIC}';

const body=document.getElementById('body'),orb=document.getElementById('orb');
const lbl=document.getElementById('lbl'),fill=document.getElementById('fill');
const pct=document.getElementById('pct'),tline=document.getElementById('tline');
const threshSlider=document.getElementById('threshSlider'),threshVal=document.getElementById('threshVal');
const muteBtn=document.getElementById('muteBtn'),pushBtn=document.getElementById('pushBtn');
const setupBox=document.getElementById('setupBox'),lastAlert=document.getElementById('lastAlert');
const dot=document.getElementById('dot'),connLbl=document.getElementById('connLbl');

let threshold=25,muted=false,crying=false,clearTimer=null;
let audioCtx=null,swReg=null,reconnectDelay=1000,threshTimer=null;

function copyCode(){
  navigator.clipboard?.writeText(CODE).catch(()=>{});
  const btn=document.querySelector('.copy-btn');
  btn.textContent='Copied!';
  setTimeout(()=>btn.textContent='Copy',1500);
}

threshSlider.oninput=()=>{
  threshold=+threshSlider.value;
  threshVal.textContent=threshold+'%';
  tline.style.left=threshold+'%';
  clearTimeout(threshTimer);
  threshTimer=setTimeout(()=>{
    fetch('/threshold?code='+CODE,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({threshold})}).catch(()=>{});
  },400);
};

function toggleMute(){
  muted=!muted;
  muteBtn.textContent=muted?'🔕 Muted':'🔔 Sound on';
  muteBtn.classList.toggle('muted',muted);
}

function testAlert(){ ensureAudio(); playBeeps(); }

function ensureAudio(){
  if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended') audioCtx.resume();
}

function onVolume(vol){
  fill.style.width=Math.min(100,vol)+'%'; pct.textContent=Math.min(100,vol)+'%';
  if(vol>=threshold){
    clearTimeout(clearTimer);
    if(!crying){ crying=true; setCrying(true); if(!muted&&audioCtx&&audioCtx.state==='running') playBeeps(); }
  }else if(crying){
    clearTimeout(clearTimer);
    clearTimer=setTimeout(()=>{ crying=false; setCrying(false); },2500);
  }
}

function setCrying(on){
  body.classList.toggle('cry',on); orb.classList.toggle('cry',on); lbl.classList.toggle('cry',on);
  orb.textContent=on?'😭':'😴'; lbl.textContent=on?'BABY CRYING!':'All Quiet';
  if(on) lastAlert.textContent='Last alert: '+new Date().toLocaleTimeString();
}

function playBeeps(){
  if(!audioCtx)return;
  const t=audioCtx.currentTime;
  [[880,0],[1046,.22],[1318,.44]].forEach(([f,d])=>{
    const osc=audioCtx.createOscillator(),g=audioCtx.createGain();
    osc.type='sine'; osc.frequency.value=f;
    g.gain.setValueAtTime(0,t+d); g.gain.linearRampToValueAtTime(.45,t+d+.025);
    g.gain.exponentialRampToValueAtTime(.001,t+d+.28);
    osc.connect(g); g.connect(audioCtx.destination); osc.start(t+d); osc.stop(t+d+.3);
  });
}

function urlB64ToUint8Array(b64){
  const pad='='.repeat((4-b64.length%4)%4);
  const raw=atob((b64+pad).replace(/-/g,'+').replace(/_/g,'/'));
  const arr=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i); return arr;
}

async function initSW(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window)){
    pushBtn.textContent='✗ Push not supported'; pushBtn.disabled=true; return;
  }
  try{
    swReg=await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const existing=await swReg.pushManager.getSubscription();
    if(existing){ await sendSub(existing); setPushActive(); }
  }catch(e){ console.error('SW error',e); }
}

async function enablePush(){
  if(!swReg){ alert('Service worker not ready. Try reloading.'); return; }
  try{
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){ pushBtn.textContent='✗ Notifications blocked'; return; }
    const sub=await swReg.pushManager.subscribe({
      userVisibleOnly:true, applicationServerKey:urlB64ToUint8Array(VAPID_KEY),
    });
    await sendSub(sub); setPushActive();
  }catch(e){ console.error('Push error',e); pushBtn.textContent='✗ Subscribe failed'; }
}

async function sendSub(sub){
  await fetch('/subscribe?code='+CODE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
}

function setPushActive(){
  pushBtn.textContent='✓ Push active'; pushBtn.classList.add('push-on'); setupBox.style.display='none';
}

function connectSSE(){
  const es=new EventSource('/events?code='+CODE);
  es.onopen=()=>{ dot.classList.remove('off'); connLbl.textContent='Connected'; reconnectDelay=1000; };
  es.onmessage=e=>{ try{ const{volume}=JSON.parse(e.data); onVolume(volume); }catch{} };
  es.onerror=()=>{
    dot.classList.add('off'); connLbl.textContent='Reconnecting…'; es.close();
    setTimeout(connectSSE,reconnectDelay); reconnectDelay=Math.min(reconnectDelay*1.5,10000);
  };
}

initSW();
connectSSE();
</script>
</body>
</html>`;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => resolve(body));
  });
}

function html(res, content) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(content); }
function json(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function redirect(res, url) { res.writeHead(302, { Location: url }); res.end(); }

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const code = (url.searchParams.get('code') || '').toUpperCase().trim();

  // ── PWA assets ──
  if (pathname === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' });
    return res.end(SW_JS);
  }
  if (pathname === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    return res.end(MANIFEST);
  }
  if (pathname === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(ICON_SVG);
  }

  // ── Landing ──
  if (pathname === '/') return html(res, LANDING_HTML);

  // ── Create room ──
  if (pathname === '/create' && req.method === 'POST') {
    return json(res, { code: createRoom() });
  }

  // ── Check room exists ──
  if (pathname === '/check') {
    return json(res, { exists: rooms.has(code) });
  }

  // ── Role pages ──
  if (pathname === '/baby') {
    if (!getRoom(code)) return redirect(res, '/');
    return html(res, buildBabyHTML(code));
  }
  if (pathname === '/parent') {
    if (!getRoom(code)) return redirect(res, '/');
    return html(res, buildParentHTML(code));
  }

  // ── SSE ──
  if (pathname === '/events') {
    const room = getRoom(code);
    if (!room) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ volume: room.lastVolume })}\n\n`);
    room.sseClients.push(res);
    req.on('close', () => { room.sseClients = room.sseClients.filter(c => c !== res); });
    return;
  }

  // ── Volume POST ──
  if (pathname === '/volume' && req.method === 'POST') {
    const room = getRoom(code);
    if (room) {
      try { const { volume } = JSON.parse(await readBody(req)); if (typeof volume === 'number') onRoomVolume(room, code, volume); }
      catch {}
    }
    res.writeHead(204); return res.end();
  }

  // ── Push subscribe ──
  if (pathname === '/subscribe' && req.method === 'POST') {
    const room = getRoom(code);
    if (room) {
      try { const sub = JSON.parse(await readBody(req)); room.pushSubs.set(sub.endpoint, sub); }
      catch {}
    }
    res.writeHead(204); return res.end();
  }

  // ── Threshold ──
  if (pathname === '/threshold' && req.method === 'POST') {
    const room = getRoom(code);
    if (room) {
      try { const { threshold } = JSON.parse(await readBody(req)); if (typeof threshold === 'number') room.threshold = Math.max(5, Math.min(80, threshold)); }
      catch {}
    }
    res.writeHead(204); return res.end();
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Baby Monitor\n');
  console.log('  http://localhost:' + PORT + '\n');
  if (!process.env.VAPID_PUBLIC_KEY) {
    console.log('  Railway environment variables (set these in your Railway project):');
    console.log('  VAPID_PUBLIC_KEY  = ' + VAPID_PUBLIC);
    console.log('  VAPID_PRIVATE_KEY = ' + VAPID_PRIVATE);
    console.log('');
  }
});
