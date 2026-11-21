// Particle effects on a full-window canvas: launch sparks, shockwaves, confetti, embers.
const canvas = document.getElementById('fx');
const g = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
let parts = [];
let rings = [];
let running = false;
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
}
resize();
window.addEventListener('resize', resize);

const rand = (a, b) => a + Math.random() * (b - a);

function loop() {
  g.clearRect(0, 0, W, H);
  // shockwave rings
  g.globalCompositeOperation = 'lighter';
  rings = rings.filter((r) => r.t < r.life);
  for (const r of rings) {
    r.t++;
    const k = r.t / r.life;
    const e = 1 - Math.pow(1 - k, 3);
    g.beginPath();
    g.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * e, 0, Math.PI * 2);
    g.strokeStyle = r.color;
    g.globalAlpha = (1 - k) * r.alpha;
    g.lineWidth = r.w * (1 - k) + 0.5;
    g.stroke();
  }
  // particles
  parts = parts.filter((p) => p.t < p.life && p.y < H + 40);
  for (const p of parts) {
    p.t++;
    if (p.t <= 0) continue; // delayed (runway lamps, beacon pulses)
    p.px = p.x; p.py = p.y;
    if (p.sway) p.vx += Math.sin((p.t + p.phase) * 0.05) * p.sway;
    p.vx *= p.drag; p.vy = p.vy * p.drag + p.grav;
    p.x += p.vx; p.y += p.vy;
    const k = p.t / p.life;
    if (p.kind === 'spark') {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = Math.max(0, 1 - k);
      g.strokeStyle = p.color;
      g.lineWidth = p.size * (1 - k * 0.7);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(p.px - p.vx * 1.6, p.py - p.vy * 1.6);
      g.lineTo(p.x, p.y);
      g.stroke();
    } else if (p.kind === 'smoke') {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = Math.max(0, p.alpha * (1 - k));
      const r = p.size * (1 + k * 2.4);
      const grd = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grd.addColorStop(0, p.color);
      grd.addColorStop(1, 'rgba(120,125,135,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fill();
    } else if (p.kind === 'ember') {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = Math.max(0, (1 - k) * 0.9);
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(p.x, p.y, p.size * (1 - k * 0.5), 0, Math.PI * 2);
      g.fill();
    } else if (p.kind === 'pixel') {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      g.fillStyle = p.color;
      const sz = Math.round(p.size);
      g.fillRect(Math.round(p.x / sz) * sz, Math.round(p.y / sz) * sz, sz, sz);
    } else if (p.kind === 'flake') {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = Math.min(1, p.t / 20) * (k > 0.8 ? (1 - k) / 0.2 : 1) * p.alpha;
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      g.fill();
    } else if (p.kind === 'hline') {
      // a laser line that stretches out sideways from the button
      g.globalCompositeOperation = 'lighter';
      const e = 1 - Math.pow(1 - k, 3);
      const half = 20 + e * p.reach;
      g.globalAlpha = (1 - k) * 0.9;
      g.strokeStyle = p.color;
      g.lineWidth = 2;
      g.shadowColor = p.color;
      g.shadowBlur = 10;
      g.beginPath();
      g.moveTo(p.x - half, p.y);
      g.lineTo(p.x + half, p.y);
      g.stroke();
      g.shadowBlur = 0;
    } else if (p.kind === 'glow' || p.kind === 'beacon') {
      // a soft light: glow swells once, a beacon pulses like a goal light
      g.globalCompositeOperation = 'lighter';
      const a = p.kind === 'beacon' ? Math.pow(Math.sin(k * Math.PI * p.pulses), 2) * (1 - k * 0.5) : Math.sin(k * Math.PI);
      const r = p.size * (p.kind === 'beacon' ? 1 : 0.6 + k * 0.6);
      const grd = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grd.addColorStop(0, p.color);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = Math.max(0, a * p.alpha);
      g.fillStyle = grd;
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fill();
    } else if (p.kind === 'rain') {
      // a column of characters: a bright head and a fading tail
      g.globalCompositeOperation = 'source-over';
      g.font = '600 13px ui-monospace, Menlo, monospace';
      const fade = k > 0.85 ? (1 - k) / 0.15 : 1;
      for (let j = 0; j < p.tail; j++) {
        const ch = p.text[(p.seed + j + ((p.t / 3) | 0)) % p.text.length];
        g.globalAlpha = Math.max(0, (j === 0 ? 1 : 0.75 * (1 - j / p.tail)) * fade);
        g.fillStyle = j === 0 ? p.head : p.color;
        g.fillText(ch, p.x, p.y - j * 15);
      }
    } else if (p.kind === 'bar') {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = (1 - k) * 0.7;
      g.fillStyle = p.color;
      g.fillRect(0, p.y, W, p.size);
    } else if (p.kind === 'firefly' || p.kind === 'spore') {
      g.globalCompositeOperation = 'lighter';
      const tw = p.kind === 'firefly' ? 0.35 + 0.65 * Math.abs(Math.sin((p.t + p.phase) * 0.06)) : 1;
      g.globalAlpha = Math.max(0, tw * Math.min(1, p.t / 15) * (k > 0.75 ? (1 - k) / 0.25 : 1));
      const grd = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 4);
      grd.addColorStop(0, p.color);
      grd.addColorStop(0.25, p.color);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2);
      g.fill();
      if (p.kind === 'firefly') { p.vx += rand(-0.12, 0.12); p.vy += rand(-0.1, 0.08); }
    } else if (p.kind === 'bubble') {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = Math.min(1, p.t / 10) * 0.9;
      g.strokeStyle = p.color;
      g.lineWidth = 1.4;
      g.beginPath();
      g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fill();
      g.globalAlpha *= 0.9;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(p.x - p.size * 0.35, p.y - p.size * 0.35, p.size * 0.22, 0, Math.PI * 2);
      g.fill();
      if (p.t >= p.life - 1) shockwave(p.x, p.y, p.color, { r0: p.size, r1: p.size * 2.2, life: 10, w: 1.5, alpha: 0.8 });
    } else if (p.kind === 'lamp') {
      // runway lights: each lamp flashes once as the sweep passes
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = Math.max(0, 1 - k);
      g.fillStyle = p.color;
      g.shadowColor = p.color;
      g.shadowBlur = 12;
      g.beginPath();
      g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
    } else {
      // confetti
      g.globalCompositeOperation = 'source-over';
      p.rot += p.vr;
      p.flip += p.vf;
      g.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.scale(1, Math.cos(p.flip));
      g.fillStyle = p.color;
      if (p.round) { g.beginPath(); g.arc(0, 0, p.size * 0.45, 0, Math.PI * 2); g.fill(); }
      else g.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
      g.restore();
    }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  if (parts.length || rings.length) requestAnimationFrame(loop);
  else { running = false; g.clearRect(0, 0, W, H); }
}
function kick() {
  if (!running) { running = true; requestAnimationFrame(loop); }
}

export function shockwave(x, y, color, { r0 = 60, r1 = 220, life = 38, w = 6, alpha = 0.9 } = {}) {
  if (reduce) return;
  rings.push({ x, y, color, r0, r1, life, w, alpha, t: 0 });
  kick();
}

export function burst(x, y, color, count = 46) {
  if (reduce) return;
  const palette = [color, '#ffffff', '#ffe2c4', color];
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(3, 11);
    parts.push({ kind: 'spark', x: x + Math.cos(a) * 50, y: y + Math.sin(a) * 50, vx: Math.cos(a) * s, vy: Math.sin(a) * s, drag: 0.91, grav: 0.12, size: rand(1.4, 3), life: rand(28, 52), t: 0, color: palette[i % palette.length] });
  }
  for (let i = 0; i < 18; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(0.5, 2.5);
    parts.push({ kind: 'ember', x: x + Math.cos(a) * 40, y: y + Math.sin(a) * 40, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.2, drag: 0.97, grav: -0.02, size: rand(1.5, 3.5), life: rand(50, 90), t: 0, color });
  }
  shockwave(x, y, color);
  shockwave(x, y, '#ffffff', { r0: 62, r1: 150, life: 22, w: 3, alpha: 0.6 });
  kick();
}

// Launch: no colour party yet. A pressure ring, a puff of exhaust smoke and a few
// white-hot sparks. Celebration is saved for when the deploy actually succeeds.
export function ignite(x, y, radius = 62) {
  if (reduce) return;
  const k = radius / 62;
  shockwave(x, y, 'rgba(160, 255, 230, 0.9)', { r0: radius, r1: radius + 120 * k, life: 34, w: 3.5, alpha: 0.85 });
  shockwave(x, y, 'rgba(255, 255, 255, 0.6)', { r0: radius * 0.9, r1: radius + 60 * k, life: 18, w: 2, alpha: 0.6 });
  for (let i = 0; i < 16; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(0.4, 1.6) * k;
    parts.push({ kind: 'smoke', x: x + Math.cos(a) * radius * 0.85, y: y + Math.sin(a) * radius * 0.85, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.35, drag: 0.975, grav: -0.015, size: rand(10, 18) * k, life: rand(55, 90), t: 0, alpha: rand(0.16, 0.28), color: 'rgba(170,176,186,0.9)' });
  }
  for (let i = 0; i < 14; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(4, 8) * k;
    parts.push({ kind: 'spark', x: x + Math.cos(a) * radius, y: y + Math.sin(a) * radius, vx: Math.cos(a) * s, vy: Math.sin(a) * s, drag: 0.88, grav: 0.05, size: rand(1, 1.8), life: rand(14, 24), t: 0, color: i % 2 ? '#ffffff' : '#b9fff0' });
  }
  kick();
}

const CONFETTI = ['#ff6b1c', '#ffc53d', '#4be39a', '#74f7d4', '#5aa9ff', '#c38bff', '#ff6fb5', '#ffffff'];

export function confetti(x, y, accent, { palette, count = 110 } = {}) {
  if (reduce) return;
  const colors = palette?.length ? palette : accent ? [accent, accent, ...CONFETTI] : CONFETTI;
  for (let i = 0; i < count; i++) {
    const a = rand(-Math.PI * 0.92, -Math.PI * 0.08);
    const s = rand(5, 15);
    parts.push({
      kind: 'confetti', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      drag: 0.965, grav: 0.32, size: rand(6, 11), life: rand(110, 170), t: 0,
      rot: rand(0, Math.PI), vr: rand(-0.25, 0.25), flip: rand(0, Math.PI), vf: rand(0.1, 0.3),
      round: Math.random() < 0.2, color: colors[(Math.random() * colors.length) | 0],
    });
  }
  shockwave(x, y, palette?.[0] || '#4be39a', { r0: 60, r1: 260, life: 50, w: 4, alpha: 0.7 });
  kick();
}

export function fizzle(x, y, palette) {
  if (reduce) return;
  const [a1, a2] = palette?.length ? [palette[0], palette[1] || palette[0]] : ['#ff5b52', '#ffb4ae'];
  for (let i = 0; i < 26; i++) {
    const a = rand(-Math.PI, 0);
    const s = rand(1, 4);
    parts.push({ kind: 'ember', x: x + rand(-40, 40), y: y + rand(-20, 30), vx: Math.cos(a) * s * 0.4, vy: Math.sin(a) * s, drag: 0.96, grav: 0.08, size: rand(1.5, 3), life: rand(30, 60), t: 0, color: i % 3 ? a1 : a2 });
  }
  shockwave(x, y, a1, { r0: 60, r1: 140, life: 26, w: 5, alpha: 0.8 });
  kick();
}

// ---------------------------------------------------------------- button pack effects
const pickFrom = (list) => list[(Math.random() * list.length) | 0];

// chunky square pixels that fall like an 8-bit explosion
export function pixels(x, y, palette, count = 90, size = 1) {
  if (reduce) return;
  for (let i = 0; i < count; i++) {
    const a = rand(-Math.PI, 0.15);
    const s = rand(3, 11);
    parts.push({ kind: 'pixel', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, drag: 0.95, grav: 0.34, size: Math.round(rand(3, 6) * size), life: rand(70, 120), t: 0, color: pickFrom(palette) });
  }
  shockwave(x, y, palette[0], { r0: 60, r1: 200, life: 30, w: 6, alpha: 0.8 });
  kick();
}

// laser lines that stretch out across the deck, plus neon rings
export function sweep(x, y, palette, size = 1) {
  if (reduce) return;
  for (let i = 0; i < 7; i++) {
    const off = (i - 3) * 14 * size;
    parts.push({ kind: 'hline', x, y: y + off, vx: 0, vy: 0, drag: 1, grav: 0, reach: W * 0.6, life: 44 + Math.abs(i - 3) * 6, t: -Math.abs(i - 3) * 3, color: palette[i % palette.length] });
  }
  palette.slice(0, 3).forEach((c, i) => setTimeout(() => shockwave(x, y, c, { r0: 50, r1: 260 * size, life: 40, w: 3, alpha: 0.9 }), i * 90));
  kick();
}

// a soft glow, for quiet packs
export function flash(x, y, color, size = 1) {
  if (reduce) return;
  parts.push({ kind: 'glow', x, y, vx: 0, vy: 0, drag: 1, grav: 0, size: 150 * size, life: 46, t: 0, alpha: 0.55, color });
  shockwave(x, y, color, { r0: 60, r1: 60 + 70 * size, life: 30, w: 2.5, alpha: 0.55 });
  kick();
}

// snow drifting down over the whole window, and a puff of colour at the button
export function snow(x, y, palette, count = 90) {
  if (reduce) return;
  for (let i = 0; i < count; i++) {
    parts.push({ kind: 'flake', x: rand(0, W), y: rand(-30, H * 0.35), vx: rand(-0.3, 0.3), vy: rand(0.8, 2), drag: 0.995, grav: 0.004, sway: rand(0.005, 0.02), phase: rand(0, 200), size: rand(1.2, 3.4), alpha: rand(0.55, 1), life: rand(220, 340), t: 0, color: '#ffffff' });
  }
  confetti(x, y, null, { palette, count: 60 });
}

// a goal light: red beacon pulses, a horn-shaped flare and an ice spray
export function goal(x, y, palette, size = 1) {
  if (reduce) return;
  const red = palette?.[0] || '#ff2a2a';
  parts.push({ kind: 'beacon', x, y, vx: 0, vy: 0, drag: 1, grav: 0, size: Math.max(W, H) * 0.7 * size, life: 110, t: 0, pulses: 3, alpha: 0.45, color: red });
  const ice = palette?.length > 1 ? palette.slice(1) : ['#ffffff', '#cfe8ff', '#9fd3ff'];
  for (let i = 0; i < 70; i++) {
    const side = i % 2 ? 1 : -1;
    const a = side > 0 ? rand(-0.9, 0.1) : Math.PI - rand(-0.9, 0.1);
    const s = rand(4, 12);
    parts.push({ kind: 'spark', x: x + side * 30, y: y + 40, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 2, drag: 0.93, grav: 0.22, size: rand(1.2, 2.6), life: rand(26, 50), t: 0, color: pickFrom(ice) });
  }
  [0, 380, 760].forEach((d) => setTimeout(() => shockwave(x, y, red, { r0: 64, r1: 220, life: 30, w: 5, alpha: 0.8 }), d));
  kick();
}

// runway approach lights: lamps flash in sequence out from the button
export function runway(x, y, palette, size = 1) {
  if (reduce) return;
  const colors = palette?.length ? palette : ['#ffd27a', '#ffffff'];
  const gap = 26 * size;
  const n = Math.ceil(Math.max(x, W - x) / gap);
  for (let i = 1; i <= n; i++) {
    for (const side of [-1, 1]) {
      for (const row of [-1, 1]) {
        parts.push({ kind: 'lamp', x: x + side * (70 + i * gap), y: y + row * 22, vx: 0, vy: 0, drag: 1, grav: 0, size: 2.6, life: 22, t: -i * 1.6, color: colors[i % colors.length] });
      }
    }
  }
  shockwave(x, y, colors[0], { r0: 60, r1: 180, life: 34, w: 3, alpha: 0.8 });
  kick();
}

// the deploy command's own characters falling in columns
export function rain(text, palette) {
  if (reduce) return;
  const chars = String(text || 'ploink deploy').replace(/\s+/g, ' ');
  const colors = palette?.length ? palette : ['#00ff66', '#0aff9d'];
  const cols = Math.min(60, Math.floor(W / 18));
  for (let c = 0; c < cols; c++) {
    if (Math.random() < 0.25) continue;
    const speed = rand(5, 11);
    parts.push({ kind: 'rain', x: c * 18 + 4, y: rand(-H * 0.6, 0), vx: 0, vy: speed, drag: 1, grav: 0, tail: 8 + ((Math.random() * 10) | 0), text: chars, seed: (Math.random() * chars.length) | 0, life: (H + 300) / speed, t: 0, color: colors[c % colors.length], head: '#e9ffef' });
  }
  kick();
}

// a column of steam that rolls up from the button
export function steam(x, y, palette, size = 1) {
  if (reduce) return;
  const color = palette?.[0] || 'rgba(235,235,230,0.95)';
  for (let i = 0; i < 34; i++) {
    const a = rand(-Math.PI * 0.75, -Math.PI * 0.25);
    const s = rand(1.5, 4) * size;
    parts.push({ kind: 'smoke', x: x + rand(-30, 30), y: y - 30, vx: Math.cos(a) * s, vy: Math.sin(a) * s, drag: 0.97, grav: -0.03, size: rand(14, 26) * size, life: rand(60, 110), t: -i * 0.6, alpha: rand(0.25, 0.45), color });
  }
  shockwave(x, y, 'rgba(255,255,255,0.7)', { r0: 60, r1: 170, life: 26, w: 3, alpha: 0.6 });
  kick();
}

// the whole console RGB-splits and tears for a third of a second
export function glitch(palette) {
  if (reduce) return;
  const root = document.documentElement;
  root.classList.remove('glitching');
  void root.offsetWidth;
  root.classList.add('glitching');
  setTimeout(() => root.classList.remove('glitching'), 360);
  const colors = palette?.length ? palette : ['#ff2a5f', '#19e6ff', '#f5e90b'];
  for (let i = 0; i < 9; i++) parts.push({ kind: 'bar', x: 0, y: rand(0, H), vx: 0, vy: 0, drag: 1, grav: 0, size: rand(3, 22), life: rand(6, 16), t: -((Math.random() * 8) | 0), color: colors[i % colors.length] });
  kick();
}

// error dialogs with one OK button; several failures cascade across the console
let dialogN = 0;
export function dialogs(x, y, label) {
  const n = dialogN++ % 8;
  const box = document.createElement('div');
  box.className = 'fx-dialog';
  const left = Math.max(12, Math.min(W - 300, x - 140 + n * 26));
  const top = Math.max(70, Math.min(H - 150, y - 70 + n * 26));
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.innerHTML = '<div class="fxd-title"><span>Deploy</span><i></i></div><div class="fxd-body"><b class="fxd-icon">!</b><span class="fxd-text"></span></div><div class="fxd-foot"><button type="button">OK</button></div>';
  box.querySelector('.fxd-text').textContent = label || 'The deploy did not finish.';
  const close = () => { box.classList.add('out'); setTimeout(() => box.remove(), 200); };
  box.querySelector('button').addEventListener('click', close);
  box.querySelector('.fxd-title i').addEventListener('click', close);
  document.body.append(box);
  setTimeout(close, 15000);
}

// glowing spores that rise and drift (snow in reverse)
export function spores(x, y, palette, count = 70) {
  if (reduce) return;
  const colors = palette?.length ? palette : ['#39ffd0', '#a66bff', '#e8ff6a'];
  for (let i = 0; i < count; i++) {
    parts.push({ kind: 'spore', x: x + rand(-80, 80), y: y + rand(-20, 40), vx: rand(-0.5, 0.5), vy: rand(-2.2, -0.6), drag: 0.995, grav: -0.004, sway: rand(0.004, 0.015), phase: rand(0, 200), size: rand(1, 2.4), life: rand(140, 240), t: 0, color: colors[i % colors.length] });
  }
  kick();
}

// fireflies that wander off from the jar
export function fireflies(x, y, palette, count = 26) {
  if (reduce) return;
  const colors = palette?.length ? palette : ['#ffe58a', '#e9c46a'];
  for (let i = 0; i < count; i++) {
    parts.push({ kind: 'firefly', x: x + rand(-30, 30), y: y + rand(-30, 30), vx: rand(-1.2, 1.2), vy: rand(-1.4, 0.2), drag: 0.985, grav: 0, phase: rand(0, 100), size: rand(1.2, 2.2), life: rand(220, 340), t: -i * 2, color: colors[i % colors.length] });
  }
  kick();
}

// bubbles that rise, wobble and pop
export function bubbles(x, y, palette, count = 28) {
  if (reduce) return;
  const colors = palette?.length ? palette : ['#7fd8e6', '#ffffff', '#f7a8c4'];
  for (let i = 0; i < count; i++) {
    parts.push({ kind: 'bubble', x: x + rand(-50, 50), y: y + rand(0, 40), vx: 0, vy: rand(-2.6, -1), drag: 0.99, grav: -0.01, sway: rand(0.02, 0.05), phase: rand(0, 100), size: rand(4, 11), life: rand(50, 110), t: -i * 2, color: colors[i % colors.length] });
  }
  kick();
}

// ---------------------------------------------------------------- dispatch by pack
let packEffects = {};
export function setEffects(effects) { packEffects = effects && typeof effects === 'object' ? effects : {}; }

/**
 * Play the effect for 'launch', 'success' or 'fail' at a button. The pack decides which one;
 * without a pack: ignite on launch, confetti on success, fizzle on failure.
 */
export function celebrate(event, x, y, accent, { radius = 62, text = '', label = '' } = {}) {
  const e = packEffects[event] || {};
  const kind = e.kind || (event === 'launch' ? 'ignite' : event === 'fail' ? 'fizzle' : 'confetti');
  const pal = e.palette;
  const size = e.size ?? 1;
  switch (kind) {
    case 'none': return;
    case 'ignite': return ignite(x, y, radius);
    case 'confetti': return confetti(x, y, accent, { palette: pal, count: e.count });
    case 'pixels': return pixels(x, y, pal || [accent || '#ff2d55', '#ffd60a', '#ffffff'], e.count, size);
    case 'sweep': return sweep(x, y, pal || ['#ff3df2', '#3df5ff'], size);
    case 'flash': return flash(x, y, pal?.[0] || accent || '#4be39a', size);
    case 'snow': return snow(x, y, pal, e.count);
    case 'goal': return goal(x, y, pal, size);
    case 'runway': return runway(x, y, pal, size);
    case 'fizzle': return fizzle(x, y, pal);
    case 'rain': return rain(text, pal);
    case 'steam': return steam(x, y, pal, size);
    case 'glitch': return glitch(pal);
    case 'dialogs': return dialogs(x, y, label);
    case 'spores': return spores(x, y, pal, e.count);
    case 'fireflies': return fireflies(x, y, pal, e.count);
    case 'bubbles': return bubbles(x, y, pal, e.count);
    default: return event === 'fail' ? fizzle(x, y) : confetti(x, y, accent);
  }
}
