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
    p.px = p.x; p.py = p.y;
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

export function confetti(x, y, accent) {
  if (reduce) return;
  const colors = accent ? [accent, accent, ...CONFETTI] : CONFETTI;
  for (let i = 0; i < 110; i++) {
    const a = rand(-Math.PI * 0.92, -Math.PI * 0.08);
    const s = rand(5, 15);
    parts.push({
      kind: 'confetti', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      drag: 0.965, grav: 0.32, size: rand(6, 11), life: rand(110, 170), t: 0,
      rot: rand(0, Math.PI), vr: rand(-0.25, 0.25), flip: rand(0, Math.PI), vf: rand(0.1, 0.3),
      round: Math.random() < 0.2, color: colors[(Math.random() * colors.length) | 0],
    });
  }
  shockwave(x, y, '#4be39a', { r0: 60, r1: 260, life: 50, w: 4, alpha: 0.7 });
  kick();
}

export function fizzle(x, y) {
  if (reduce) return;
  for (let i = 0; i < 26; i++) {
    const a = rand(-Math.PI, 0);
    const s = rand(1, 4);
    parts.push({ kind: 'ember', x: x + rand(-40, 40), y: y + rand(-20, 30), vx: Math.cos(a) * s * 0.4, vy: Math.sin(a) * s, drag: 0.96, grav: 0.08, size: rand(1.5, 3), life: rand(30, 60), t: 0, color: i % 3 ? '#ff5b52' : '#ffb4ae' });
  }
  shockwave(x, y, '#ff5b52', { r0: 60, r1: 140, life: 26, w: 5, alpha: 0.8 });
  kick();
}
