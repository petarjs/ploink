// Button packs: data-only looks. A pack picks building blocks the app already has (cap material,
// bezel, LED style, readout, panel, effects) and tunes them with colours, sound recipes and words.
// Packs carry no code and no URLs. Anything unknown falls back to the default and is reported.
import fs from 'node:fs';
import path from 'node:path';

export const PACK_FORMAT = 1;
export const PACK_EXT = '.ploinkpack';
export const MAX_PACK_BYTES = 64 * 1024;
export const DEFAULT_PACK_ID = 'dev.ploink.mission-control';
const OFFICIAL_PREFIX = 'dev.ploink.';

export const BLOCKS = {
  material: ['gloss', 'concave', 'matte', 'glass', 'metal', 'puck', 'ornament', 'flat', 'droplet', 'clay', 'membrane', 'sewn', 'duck'],
  shape: ['round', 'square', 'sphere', 'cube', 'cylinder', 'cone', 'torus', 'icosahedron'],
  bezel: ['steel', 'black', 'brass', 'chrome', 'neon', 'outline', 'bevel', 'dimple'],
  led: ['dots', 'segments', 'comet', 'bulbs', 'gauge', 'arc', 'orbit'],
  readout: ['vfd', 'seven-seg', 'dot-matrix', 'backlit', 'terminal', 'frosted', 'marquee', 'glyph', 'crt'],
  panel: ['plain', 'wood', 'grid', 'scanlines', 'rink', 'frost', 'hazard', 'cells', 'aurora', 'hud', 'starfield', 'window', 'studio', 'linen', 'tiles'],
  log: ['receipt', 'terminal', 'ledger', 'parchment', 'jcard', 'scoresheet', 'worksheet', 'frosted', 'card', 'dispatch', 'hud', 'minimal', 'guestbook', 'window', 'clay', 'membrane', 'scene', 'dossier', 'sampler', 'pinboard', 'newspaper', 'slips', 'mirror', 'tarot'],
  surface: ['dark', 'light'],
  effect: ['confetti', 'pixels', 'sweep', 'flash', 'snow', 'goal', 'runway', 'fizzle', 'ignite', 'rain', 'steam', 'glitch', 'dialogs', 'spores', 'fireflies', 'bubbles', 'none'],
  wave: ['sine', 'square', 'sawtooth', 'triangle'],
  filter: ['lowpass', 'highpass', 'bandpass'],
};

// The sounds in renderer/audio.js. A pack may replace any of them; [] means silence.
export const SOUND_EVENTS = ['press', 'release', 'tick', 'launch', 'success', 'fail', 'request', 'click', 'denied', 'install', 'whoosh', 'thunk', 'boot', 'printer'];
export const EFFECT_EVENTS = ['launch', 'success', 'fail'];
// Words a pack may rename: readout states, the activity log's title and its filters.
// FAILED also renames "FAILED · EXIT 1" and the log's failures filter.
export const WORD_KEYS = ['READY', 'IGNITION', 'IN FLIGHT', 'SHIPPED', 'FAILED', 'ABORTED', 'IDLE', 'FLIGHT LOG', 'ALL', 'AGENT'];

// CSS custom properties a pack may set. Every default lives in styles.css / bar.css.
export const TOKENS = [
  '--chassis', '--chassis-top', '--chassis-bot', '--topbar-top', '--topbar-bot',
  '--plate', '--plate-hi', '--plate-lo', '--hole', '--hole-hi', '--line',
  '--ink', '--ink-2', '--muted', '--engrave',
  '--vfd', '--vfd-glow', '--vfd-dim', '--ok', '--bad', '--warn', '--brand', '--brand-lo',
  '--bay-top', '--bay-mid', '--bay-bot', '--led-off', '--led-trail', '--lcd-1', '--lcd-2', '--screw', '--screw-slot',
  // surfaces that light packs repaint (all default to the classic dark values)
  '--key-top', '--key-bot', '--key-hover-top', '--key-hover-bot', '--key-edge', '--thumb-top', '--thumb-bot',
  '--well', '--well-top', '--well-bot', '--lamp-off', '--strip', '--scroll', '--ring',
  '--socket', '--socket-ring', '--socket-ink', '--medal-1', '--medal-2',
  // readout colours after a deploy ships, fails or needs attention (light readouts need darker ones)
  '--tone-ok', '--tone-bad', '--tone-warn',
];

// Ticker lines a pack can add ("quips"), shown on a bay when something happens.
export const QUIP_EVENTS = ['hold', 'launch', 'success', 'fail'];
const QUIP_RE = /^[\x20-\x7e\u00a0-\u024f\u2018-\u201d\u2026]{1,60}$/;

const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(\s*[-\d.%\s,/]+\)|transparent)$/i;
const LENGTH_RE = /^-?\d{1,4}(\.\d{1,3})?(px|%|em|rem)$/;
const NUMBER_RE = /^-?\d{1,4}(\.\d{1,3})?$/;
const ID_RE = /^[a-z0-9][a-z0-9.-]{2,63}$/;
const WORD_RE = /^[A-Z0-9 !?.,'&:+-]{1,14}$/;

export const isColor = (v) => typeof v === 'string' && v.length <= 40 && COLOR_RE.test(v.trim());
const isTokenValue = (v) => typeof v === 'string' && v.length <= 40 && (COLOR_RE.test(v.trim()) || LENGTH_RE.test(v.trim()) || NUMBER_RE.test(v.trim()));

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v) => Math.round(v * 10000) / 10000;

function pick(value, allowed, fallback, warn, what) {
  if (value === undefined || value === null) return fallback;
  if (allowed.includes(value)) return value;
  warn(fallback === null ? `Unknown ${what} "${String(value).slice(0, 30)}", skipped.` : `Unknown ${what} "${String(value).slice(0, 30)}", using "${fallback}".`);
  return fallback;
}

const HEX6_RE = /^#[0-9a-f]{6}$/i;

function palette(list, max, warn, what, test = isColor) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) { warn(`${what} must be a list of colours.`); return undefined; }
  const out = list.filter((c) => typeof c === 'string' && test(c.trim())).map((c) => c.trim()).slice(0, max);
  if (out.length < list.length) warn(`${what}: kept ${out.length} of ${list.length} colours.`);
  return out.length ? out : undefined;
}

/** One tone or noise step of a sound recipe, with every number clamped to a safe range. */
export function cleanSoundStep(s) {
  if (!s || typeof s !== 'object') return null;
  const kind = s.kind === 'tone' || s.kind === 'noise' ? s.kind : null;
  if (!kind) return null;
  const step = { kind };
  step.type = kind === 'tone' ? (BLOCKS.wave.includes(s.type) ? s.type : 'sine') : (BLOCKS.filter.includes(s.type) ? s.type : 'bandpass');
  step.freq = round(clamp(num(s.freq, kind === 'tone' ? 440 : 2000), 20, 12000));
  if (s.to !== undefined) step.to = round(clamp(num(s.to, step.freq), 20, 12000));
  step.at = round(clamp(num(s.at, 0), 0, 2.5));
  step.attack = round(clamp(num(s.attack, 0.004), 0.001, 1));
  step.peak = round(clamp(num(s.peak, 0.2), 0.0002, 0.6));
  step.decay = round(clamp(num(s.decay, 0.2), 0.005, 2.5));
  // the whole step must end inside 3 seconds
  const over = step.at + step.attack + step.decay - 3;
  if (over > 0) step.decay = round(Math.max(0.005, step.decay - over));
  if (kind === 'tone' && s.detune !== undefined) step.detune = round(clamp(num(s.detune, 0), -1200, 1200));
  if (kind === 'noise' && s.q !== undefined) step.q = round(clamp(num(s.q, 1), 0.1, 30));
  if (s.rise !== undefined) step.rise = round(clamp(num(s.rise, 1.6), -3, 3)); // tick only: pitch climbs this many octaves over the charge
  if (s.echo === true) step.echo = true;
  return step;
}

function cleanEffect(e, warn, event) {
  if (e === null) return { kind: 'none' };
  if (!e || typeof e !== 'object') { warn(`effects.${event} must be an object.`); return undefined; }
  const out = { kind: pick(e.kind, BLOCKS.effect, event === 'fail' ? 'fizzle' : event === 'launch' ? 'ignite' : 'confetti', warn, `effect for ${event}`) };
  const pal = palette(e.palette, 8, warn, `effects.${event}.palette`);
  if (pal) out.palette = pal;
  if (e.count !== undefined) out.count = Math.round(clamp(num(e.count, 80), 1, 200));
  if (e.size !== undefined) out.size = round(clamp(num(e.size, 1), 0.5, 2));
  return out;
}

/**
 * Check a parsed pack and return a clean copy: { pack, warnings } or { error }.
 * Only known fields survive. Numbers are clamped, unknown building blocks fall back to defaults.
 */
export function validatePack(input) {
  const warnings = [];
  const warn = (m) => { if (warnings.length < 30) warnings.push(m); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'A pack must be a JSON object.' };
  if (input.format !== PACK_FORMAT) {
    return { error: typeof input.format === 'number' && input.format > PACK_FORMAT ? 'This pack was made for a newer Ploink. Update the app to use it.' : 'Not a Ploink pack: "format" must be 1.' };
  }
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) return { error: 'The pack id must be 3 to 64 lowercase letters, digits, dots or dashes, like "com.you.neon".' };
  const name = text(input.name, 32);
  if (!name) return { error: 'The pack needs a name.' };

  const pack = {
    format: PACK_FORMAT,
    id: input.id,
    name,
    version: text(input.version || '1.0.0', 16),
    author: text(input.author, 40),
    description: text(input.description, 160),
    tier: input.tier === 'pro' ? 'pro' : 'free',
    tokens: {},
    cap: { material: 'gloss' },
    bezel: { style: 'steel' },
    led: { style: 'dots' },
    readout: { style: 'vfd' },
    panel: { style: 'plain' },
    log: { style: 'receipt' },
    surface: 'dark',
    sounds: {},
    effects: {},
    words: {},
  };

  if (input.tokens !== undefined) {
    if (!input.tokens || typeof input.tokens !== 'object' || Array.isArray(input.tokens)) warn('tokens must be an object.');
    else {
      for (const [k, v] of Object.entries(input.tokens)) {
        if (!TOKENS.includes(k)) { warn(`Token ${k.slice(0, 30)} is not allowed.`); continue; }
        if (!isTokenValue(v)) { warn(`Token ${k} has a value that is not a colour, length or number.`); continue; }
        pack.tokens[k] = v.trim();
      }
    }
  }

  const part = (key) => (input[key] && typeof input[key] === 'object' && !Array.isArray(input[key]) ? input[key] : {});
  pack.cap.material = pick(part('cap').material, BLOCKS.material, 'gloss', warn, 'cap material');
  // shape: one name, or a list used in turn per project (like the palette)
  const shape = part('cap').shape;
  if (Array.isArray(shape)) {
    const list = shape.slice(0, 8).map((x) => pick(x, BLOCKS.shape, null, warn, 'cap shape')).filter(Boolean);
    if (list.length) pack.cap.shape = list;
  } else if (shape !== undefined) {
    const one = pick(shape, BLOCKS.shape, null, warn, 'cap shape');
    if (one) pack.cap.shape = one;
  }
  // cap colours feed the same maths as project colours, which needs #rrggbb
  const capPal = palette(part('cap').palette, 6, warn, 'cap.palette (use #rrggbb)', (c) => HEX6_RE.test(c));
  if (capPal) pack.cap.palette = capPal;
  pack.bezel.style = pick(part('bezel').style, BLOCKS.bezel, 'steel', warn, 'bezel style');
  pack.led.style = pick(part('led').style, BLOCKS.led, 'dots', warn, 'LED style');
  const ledPal = palette(part('led').palette, 4, warn, 'led.palette');
  if (ledPal) pack.led.palette = ledPal;
  pack.readout.style = pick(part('readout').style, BLOCKS.readout, 'vfd', warn, 'readout style');
  pack.panel.style = pick(part('panel').style, BLOCKS.panel, 'plain', warn, 'panel style');
  pack.log.style = pick(part('log').style, BLOCKS.log, 'receipt', warn, 'log style');
  pack.surface = pick(input.surface, BLOCKS.surface, 'dark', warn, 'surface');

  if (input.quips !== undefined) {
    if (!Array.isArray(input.quips)) warn('quips must be a list.');
    else {
      const quips = [];
      for (const q of input.quips.slice(0, 40)) {
        if (!q || typeof q !== 'object' || !QUIP_EVENTS.includes(q.on)) { warn('Each quip needs "on": hold, launch, success or fail.'); continue; }
        const textValue = text(q.text, 60);
        if (!QUIP_RE.test(textValue)) { warn(`A quip for ${q.on} has no text, or characters that are not allowed.`); continue; }
        const quip = { on: q.on, text: textValue };
        if (Array.isArray(q.days)) {
          const days = [...new Set(q.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
          if (days.length) quip.days = days; // 0 = Sunday, like Date.getDay()
        }
        if (Array.isArray(q.hours) && q.hours.length === 2 && q.hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 24) && q.hours[0] < q.hours[1]) {
          quip.hours = [q.hours[0], q.hours[1]]; // from (inclusive) to (exclusive), local time
        }
        if (q.chance !== undefined) quip.chance = round(clamp(num(q.chance, 1), 0, 1));
        quips.push(quip);
      }
      if (input.quips.length > 40) warn('quips: kept the first 40.');
      if (quips.length) pack.quips = quips;
    }
  }

  if (input.sounds !== undefined) {
    const sounds = part('sounds');
    for (const [event, steps] of Object.entries(sounds)) {
      if (!SOUND_EVENTS.includes(event)) { warn(`Unknown sound event "${event.slice(0, 30)}".`); continue; }
      if (steps === null) { pack.sounds[event] = []; continue; }
      if (!Array.isArray(steps)) { warn(`sounds.${event} must be a list of steps.`); continue; }
      const clean = steps.slice(0, 16).map(cleanSoundStep).filter(Boolean);
      if (clean.length < Math.min(steps.length, 16)) warn(`sounds.${event}: dropped steps that are not tone or noise.`);
      if (steps.length > 16) warn(`sounds.${event}: kept the first 16 steps.`);
      pack.sounds[event] = clean;
    }
  }

  if (input.effects !== undefined) {
    const effects = part('effects');
    for (const [event, e] of Object.entries(effects)) {
      if (!EFFECT_EVENTS.includes(event)) { warn(`Unknown effect event "${event.slice(0, 30)}".`); continue; }
      const clean = cleanEffect(e, warn, event);
      if (clean) pack.effects[event] = clean;
    }
  }

  if (input.words !== undefined) {
    const words = part('words');
    for (const [k, v] of Object.entries(words)) {
      if (!WORD_KEYS.includes(k)) { warn(`Unknown readout word "${k.slice(0, 30)}".`); continue; }
      const w = text(v, 14).toUpperCase();
      if (!WORD_RE.test(w)) { warn(`words.${k} must be 1 to 14 letters, digits or simple punctuation.`); continue; }
      pack.words[k] = w;
    }
  }
  return { pack, warnings };
}

/** Parse and validate a pack file's text. */
export function parsePack(raw) {
  if (typeof raw !== 'string') return { error: 'Could not read the pack.' };
  if (Buffer.byteLength(raw) > MAX_PACK_BYTES) return { error: 'The pack is larger than 64 KB.' };
  let data;
  try { data = JSON.parse(raw); } catch { return { error: 'The pack is not valid JSON.' }; }
  return validatePack(data);
}

function readPackFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: 'Not a file.' };
    if (st.size > MAX_PACK_BYTES) return { error: 'The pack is larger than 64 KB.' };
    return parsePack(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: `Could not read the pack: ${err.message}` };
  }
}

/** Every valid pack in a folder, sorted by file name. Bad files are skipped. */
export function loadPackDir(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(PACK_EXT)).sort(); } catch { return []; }
  return names.map((n) => readPackFile(path.join(dir, n)).pack).filter(Boolean);
}

/**
 * The full pack list: built-in packs, then Pro packs, then community packs the user installed.
 * source: 'builtin' | 'pro' | 'community'. Community packs may not use an official id.
 */
export function packCatalog({ builtin = [], pro = [], community = [] }) {
  const seen = new Set();
  const out = [];
  const add = (pack, source) => {
    if (!pack || seen.has(pack.id)) return;
    if (source === 'community' && pack.id.startsWith(OFFICIAL_PREFIX)) return;
    seen.add(pack.id);
    out.push({ ...pack, tier: source === 'pro' ? 'pro' : source === 'community' ? 'free' : pack.tier, source });
  };
  for (const p of builtin) add(p, 'builtin');
  for (const p of pro) add(validatePack(p).pack, 'pro');
  for (const p of community) add(p, 'community');
  return out;
}

export const packLocked = (pack, pro) => !!pack && pack.tier === 'pro' && !pro;

/** The pack to show: the chosen one when it exists and is unlocked, else the default. */
export function resolvePack(catalog, id, { pro = false } = {}) {
  const chosen = catalog.find((p) => p.id === id);
  if (chosen && !packLocked(chosen, pro)) return chosen;
  return catalog.find((p) => p.id === DEFAULT_PACK_ID) || catalog.find((p) => !packLocked(p, pro)) || null;
}

/** Copy a .ploinkpack file into the user's pack folder. Returns { pack, warnings } or { error }. */
export function installPackFile(file, userDir) {
  if (!String(file).endsWith(PACK_EXT)) return { error: `Ploink packs end in ${PACK_EXT}.` };
  const res = readPackFile(file);
  if (res.error) return res;
  if (res.pack.id.startsWith(OFFICIAL_PREFIX)) return { error: 'Pack ids that start with dev.ploink. are reserved for official packs. Change the id and try again.' };
  fs.mkdirSync(userDir, { recursive: true });
  const dest = path.join(userDir, `${res.pack.id}${PACK_EXT}`);
  fs.writeFileSync(dest, JSON.stringify(res.pack, null, 2), { mode: 0o644 });
  return res;
}

/** Remove an installed community pack. */
export function removePackFile(id, userDir) {
  if (!ID_RE.test(String(id))) return false;
  try { fs.unlinkSync(path.join(userDir, `${id}${PACK_EXT}`)); return true; } catch { return false; }
}
