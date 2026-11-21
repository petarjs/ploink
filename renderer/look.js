// Button packs in the renderer. A pack (already checked by main/packs.mjs) sets CSS tokens,
// picks building blocks through data attributes on <html>, and replaces sounds, effects and
// readout words. Shared by the console (app.js) and the launch bar (bar.js).
import { setSoundPack } from './audio.js';
import { setEffects } from './fx.js';
import { colorFromName } from './util.js';

const root = document.documentElement;
let current = null;
let applied = [];

export function applyPack(pack) {
  current = pack || null;
  for (const k of applied) root.style.removeProperty(k);
  applied = [];
  const set = (k, v) => { root.style.setProperty(k, v); applied.push(k); };
  for (const [k, v] of Object.entries(pack?.tokens || {})) if (k.startsWith('--')) set(k, v);
  const leds = pack?.led?.palette || [];
  if (leds.length) for (let i = 0; i < 4; i++) set(`--led-${i + 1}`, leds[i % leds.length]);
  root.dataset.pack = pack?.id || '';
  root.dataset.cap = pack?.cap?.material || 'gloss';
  root.dataset.bezel = pack?.bezel?.style || 'steel';
  root.dataset.led = pack?.led?.style || 'dots';
  root.dataset.readout = pack?.readout?.style || 'vfd';
  root.dataset.panel = pack?.panel?.style || 'plain';
  root.dataset.log = pack?.log?.style || 'receipt';
  root.dataset.surface = pack?.surface || 'dark';
  const shape = pack?.cap?.shape;
  root.dataset.shape = typeof shape === 'string' ? shape : Array.isArray(shape) ? 'mixed' : '';
  setSoundPack(pack?.sounds || {});
  setEffects(pack?.effects || {});
}

export const currentPack = () => current;

/** The cap colour of a project: the pack's palette (cycled by position) or the project's own colour. */
export function capColor(project, index = 0) {
  const pal = current?.cap?.palette;
  if (pal?.length) return pal[index % pal.length];
  return project.color || colorFromName(project.name);
}

/** The pack's cap shape for a project: one name, or a list used in turn. '' = the user's setting. */
export function capShape(index = 0) {
  const shape = current?.cap?.shape;
  if (Array.isArray(shape)) return shape[index % shape.length];
  return shape || '';
}

/** round | square when the pack decides the button outline, else null (the user's setting wins). */
export function packOutline() {
  const shape = current?.cap?.shape;
  return shape === 'round' || shape === 'square' ? shape : null;
}

export const readoutStyle = () => current?.readout?.style || 'vfd';
export const ledStyle = () => current?.led?.style || 'dots';
export const logStyle = () => current?.log?.style || 'receipt';

/** A pack quip for this moment, or null. on: hold | launch | success | fail. */
export function quip(on, now = new Date()) {
  const list = (current?.quips || []).filter((q) => q.on === on
    && (!q.days || q.days.includes(now.getDay()))
    && (!q.hours || (now.getHours() >= q.hours[0] && now.getHours() < q.hours[1])));
  if (!list.length) return null;
  const q = list[(Math.random() * list.length) | 0];
  return q.chance !== undefined && Math.random() > q.chance ? null : q.text;
}

/** While holding: characters lock in left to right, the rest keep scrambling ("brute force"). */
const SCRAMBLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&@*';
export function scramble(text, t) {
  const s = String(text).toUpperCase();
  const locked = Math.floor(s.length * Math.min(1, Math.max(0, t)));
  let out = s.slice(0, locked);
  for (let i = locked; i < s.length; i++) out += s[i] === ' ' ? ' ' : SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
  return out;
}

// ---- glyph readout: an invented stroke alphabet, drawn by the app (no real script) ----
const glyphCache = new Map();
function glyphPath(ch) {
  if (glyphCache.has(ch)) return glyphCache.get(ch);
  let n = 2166136261;
  for (const c of 'xeno' + ch) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  const rnd = () => { n = Math.imul(n ^ (n >>> 15), 2246822507) >>> 0; n = Math.imul(n ^ (n >>> 13), 3266489909) >>> 0; return (n >>> 0) / 4294967296; };
  const pts = [[1, 1], [5, 1], [3, 0], [1, 5], [5, 5], [3, 4], [1, 9], [5, 9], [3, 10]];
  let d = '';
  const strokes = 2 + Math.floor(rnd() * 2);
  for (let i = 0; i < strokes; i++) {
    const a = pts[Math.floor(rnd() * pts.length)];
    const b = pts[Math.floor(rnd() * pts.length)];
    const c = pts[Math.floor(rnd() * pts.length)];
    d += `M${a[0]} ${a[1]}Q${b[0]} ${b[1]} ${c[0]} ${c[1]}`;
  }
  if (rnd() > 0.5) d += `M${2 + Math.floor(rnd() * 3)} ${3 + Math.floor(rnd() * 5)}h0.01`;
  glyphCache.set(ch, d);
  return d;
}
/** Text as alien glyphs (SVG), with the plain text kept for hover and screen readers. */
export function glyphText(text) {
  const span = document.createElement('span');
  span.className = 'glyphs';
  const plain = document.createElement('span');
  plain.className = 'plain';
  plain.textContent = text;
  const glyphs = document.createElement('span');
  glyphs.className = 'alien';
  glyphs.setAttribute('aria-hidden', 'true');
  let html = '';
  for (const ch of String(text).toUpperCase()) {
    html += ch === ' ' ? '<i class="gsp"></i>' : `<svg viewBox="0 0 6 11" class="g"><path d="${glyphPath(ch)}"/></svg>`;
  }
  glyphs.innerHTML = html;
  span.append(glyphs, plain);
  return span;
}

// ---- bug specimens: a symmetric pixel beetle and a mock-Latin name, both from a seed ----
function seeded(seed) {
  let n = 2166136261;
  for (const c of String(seed)) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { n = Math.imul(n ^ (n >>> 15), 2246822507) >>> 0; n = Math.imul(n ^ (n >>> 13), 3266489909) >>> 0; return (n >>> 0) / 4294967296; };
}
export function specimenSvg(seed, colors = ['#b5523b', '#2a1f14', '#e9c46a']) {
  const rnd = seeded(seed);
  const W = 7, H = 9;
  let rects = '';
  const body = colors[Math.floor(rnd() * colors.length)];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < Math.ceil(W / 2); x++) {
      const edge = x === 0 || y === 0 || y === H - 1;
      const on = (y === 1 && x === 3) || (y > 1 && y < H - 1 && x > 0 && rnd() > 0.32) || (edge && rnd() > 0.78);
      if (!on) continue;
      const fill = y < 2 ? '#2a1f14' : rnd() > 0.85 ? colors[2] || body : body;
      for (const xx of new Set([x, W - 1 - x])) rects += `<rect x="${xx}" y="${y}" width="1" height="1" fill="${fill}"/>`;
    }
  }
  // legs and antennae
  rects += `<path d="M1 3H0M1 5H0M1 7H0M6 3H7M6 5H7M6 7H7M2 1L1 0M5 1L6 0" stroke="#2a1f14" stroke-width="0.35"/>`;
  return `<svg class="specimen" viewBox="-0.5 -0.5 8 10" shape-rendering="crispEdges">${rects}</svg>`;
}
export function specimenName(projectName, exitCode, seed) {
  const rnd = seeded(seed);
  const stem = String(projectName || 'Deploy').split(/[^a-z0-9]+/i).filter(Boolean)[0] || 'Deploy';
  const genus = stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase().replace(/[aeiou]+$/, '') + ['ia', 'ius', 'ella', 'ops', 'odes'][Math.floor(rnd() * 5)];
  return `${genus} exitus-${exitCode ?? 'x'}`;
}

/** A readout word, renamed by the pack when it has one ("SHIPPED" -> "GOAL!"). */
export function word(status) {
  const w = current?.words;
  if (!w || !status) return status;
  if (w[status]) return w[status];
  for (const key of ['FAILED', 'IN FLIGHT', 'SHIPPED']) {
    if (w[key] && status.startsWith(key + ' ')) return w[key] + status.slice(key.length);
  }
  return status;
}

// ---- small static previews for the pack picker ----
const FACE = {
  gloss: (c) => `radial-gradient(70% 60% at 50% 0%, rgba(255,255,255,.3), transparent 70%), linear-gradient(180deg, color-mix(in srgb, ${c} 60%, white), ${c} 45%, color-mix(in srgb, ${c} 80%, black))`,
  concave: (c) => `radial-gradient(60% 50% at 50% 92%, rgba(255,255,255,.28), transparent 70%), radial-gradient(85% 75% at 50% 20%, rgba(0,0,0,.38), transparent 70%), ${c}`,
  matte: (c) => `linear-gradient(180deg, color-mix(in srgb, ${c} 80%, #9a9a9a), color-mix(in srgb, ${c} 70%, #222))`,
  glass: (c) => `radial-gradient(70% 40% at 50% 6%, rgba(255,255,255,.6), transparent 70%), radial-gradient(80% 60% at 50% 115%, ${c}, transparent 70%), color-mix(in srgb, ${c} 40%, #0a0614)`,
  metal: () => 'conic-gradient(from 200deg, #8f939b, #eef0f3 12%, #8a8e96 26%, #f4f5f7 41%, #7d8189 56%, #dfe2e6 71%, #868a92 86%, #8f939b)',
  puck: () => 'radial-gradient(70% 50% at 50% 12%, rgba(255,255,255,.14), transparent 70%), radial-gradient(circle at 50% 45%, #2a2b2f, #0c0c0e 72%)',
  ornament: (c) => `radial-gradient(22% 16% at 34% 24%, rgba(255,255,255,.95), transparent 100%), radial-gradient(circle at 50% 45%, color-mix(in srgb, ${c} 60%, white), ${c} 45%, color-mix(in srgb, ${c} 55%, black))`,
  flat: (c) => c,
  droplet: (c) => `radial-gradient(40% 26% at 38% 22%, rgba(255,255,255,.85), transparent 100%), radial-gradient(80% 60% at 50% 110%, color-mix(in srgb, ${c} 45%, transparent), transparent 70%), rgba(255,255,255,.1)`,
  clay: (c) => `radial-gradient(55% 45% at 38% 30%, rgba(255,255,255,.5), transparent 70%), ${c}`,
  membrane: (c) => `radial-gradient(circle at 50% 55%, color-mix(in srgb, ${c} 70%, white), color-mix(in srgb, ${c} 40%, #061014))`,
  sewn: (c) => `radial-gradient(circle at 40% 40%, #2b211a 0 6%, transparent 7%), radial-gradient(circle at 60% 40%, #2b211a 0 6%, transparent 7%), radial-gradient(circle at 40% 60%, #2b211a 0 6%, transparent 7%), radial-gradient(circle at 60% 60%, #2b211a 0 6%, transparent 7%), ${c}`,
  duck: (c) => `radial-gradient(circle at 38% 36%, #1b1b1b 0 5%, transparent 6%), radial-gradient(circle at 62% 36%, #1b1b1b 0 5%, transparent 6%), radial-gradient(18% 10% at 50% 52%, #ff8c42 98%, transparent), radial-gradient(70% 60% at 50% 0%, rgba(255,255,255,.3), transparent 70%), ${c}`,
};
const RING = { steel: '#6f727b', black: '#2a2c31', brass: '#c9a23e', chrome: '#d9dce1', neon: 'var(--pv-vfd)', outline: '#111111', bevel: '#c0c0c0', dimple: 'rgba(0,0,0,.12)' };

/** Colours and gradients a picker tile needs to sketch a pack. */
export function previewVars(pack, sample = '#e5484d') {
  const t = pack.tokens || {};
  const cap = pack.cap?.palette?.[0] || sample;
  const mat = pack.cap?.material || 'gloss';
  const vfd = t['--vfd'] || '#74f7d4';
  const leds = pack.led?.palette?.length ? pack.led.palette : [pack.led?.style === 'comet' ? vfd : cap];
  return {
    '--pv-bg': t['--chassis-top'] || t['--chassis'] || '#17181c',
    '--pv-bay': t['--bay-top'] || '#25262b',
    '--pv-face': (FACE[mat] || FACE.gloss)(cap),
    '--pv-ring': RING[pack.bezel?.style] || RING.steel,
    '--pv-vfd': vfd,
    '--pv-lcd': t['--lcd-2'] || '#040706',
    '--pv-led-1': leds[0],
    '--pv-led-2': leds[1 % leds.length],
    '--pv-led-3': leds[2 % leds.length],
    '--pv-led-4': leds[3 % leds.length],
    '--pv-ring-cap': mat === 'metal' || mat === 'puck' ? cap : 'transparent',
  };
}
