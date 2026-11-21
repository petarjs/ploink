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
};
const RING = { steel: '#6f727b', black: '#2a2c31', brass: '#c9a23e', chrome: '#d9dce1', neon: 'var(--pv-vfd)' };

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
