// Small helpers: DOM builder, colours, ANSI → HTML, time formatting.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- colour ----------
export const CAP_COLORS = [
  { name: 'Signal Red', hex: '#e5484d', hue: 358 },
  { name: 'Orange', hex: '#f76b15', hue: 23 },
  { name: 'Amber', hex: '#f5b82e', hue: 42 },
  { name: 'Lime', hex: '#8fc93a', hue: 85 },
  { name: 'Green', hex: '#2fa86a', hue: 151 },
  { name: 'Teal', hex: '#13a596', hue: 173 },
  { name: 'Sky', hex: '#1e93f0', hue: 206 },
  { name: 'Indigo', hex: '#4a63e0', hue: 228 },
  { name: 'Violet', hex: '#8e4ec6', hue: 275 },
  { name: 'Pink', hex: '#d6409f', hue: 322 },
  { name: 'Graphite', hex: '#5a5d65', hue: null },
  { name: 'Ivory', hex: '#e9e4d4', hue: null },
];

export function hexToRgb(hex) {
  const m = String(hex).replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export function mix(hex, withHex, amt) {
  const a = hexToRgb(hex), b = hexToRgb(withHex);
  return toHex(a[0] + (b[0] - a[0]) * amt, a[1] + (b[1] - a[1]) * amt, a[2] + (b[2] - a[2]) * amt);
}
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function capVars(hex) {
  const base = hex || '#5a5d65';
  const [r, g, b] = hexToRgb(base);
  const light = luminance(base) > 0.62;
  return {
    vars: {
      '--cap': base,
      '--cap-hi': mix(base, '#ffffff', light ? 0.5 : 0.32),
      '--cap-lo': mix(base, '#000000', light ? 0.42 : 0.55),
      '--cap-glow': `rgba(${r}, ${g}, ${b}, 0.6)`,
    },
    tone: light ? 'light' : 'dark',
  };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hh;
  if (max === r) hh = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  return [hh * 60, s, l];
}

/** Pick the cap colour that best matches an icon's dominant hue. */
export async function colorFromIcon(dataUrl) {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const N = 28;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, N, N);
    const d = x.getImageData(0, 0, N, N).data;
    const buckets = new Array(36).fill(0);
    let colorful = 0, opaque = 0, lumSum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (a < 0.5) continue;
      opaque++;
      const [hh, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      lumSum += l;
      if (s > 0.28 && l > 0.18 && l < 0.88) {
        const w = s * a * (1 - Math.abs(l - 0.5));
        buckets[Math.floor(hh / 10) % 36] += w;
        colorful += w;
      }
    }
    if (!opaque) return null;
    if (colorful / opaque < 0.06) {
      return lumSum / opaque < 0.5 ? '#e9e4d4' : '#5a5d65';
    }
    let best = 0;
    for (let i = 1; i < 36; i++) if (buckets[i] > buckets[best]) best = i;
    const hue = best * 10 + 5;
    let pick = CAP_COLORS[0], bestDist = 999;
    for (const cc of CAP_COLORS) {
      if (cc.hue == null) continue;
      const dist = Math.min(Math.abs(cc.hue - hue), 360 - Math.abs(cc.hue - hue));
      if (dist < bestDist) { bestDist = dist; pick = cc; }
    }
    return pick.hex;
  } catch {
    return null;
  }
}

export function colorFromName(name) {
  let n = 0;
  for (const ch of String(name)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const vivid = CAP_COLORS.filter((c) => c.hue != null);
  return vivid[n % vivid.length].hex;
}

export function monogram(name) {
  const words = String(name).trim().split(/[\s\-_.]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  return (words[0][0] + words[1][0]).toUpperCase();
}

// ---------- ANSI ----------
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g;
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}
export function ansiToHtml(line) {
  let out = '';
  let last = 0;
  let open = 0;
  let classes = new Set();
  const flush = (text) => {
    if (!text) return;
    out += classes.size ? `<span class="${[...classes].join(' ')}">${esc(text)}</span>` : esc(text);
  };
  SGR.lastIndex = 0;
  let m;
  while ((m = SGR.exec(line))) {
    flush(line.slice(last, m.index));
    last = SGR.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) classes = new Set();
      else if (c === 1) classes.add('a-b');
      else if (c === 2) classes.add('a-d');
      else if (c === 3) classes.add('a-i');
      else if (c === 4) classes.add('a-u');
      else if (c === 22) { classes.delete('a-b'); classes.delete('a-d'); }
      else if (c === 39) { for (const k of [...classes]) if (/^a-\d/.test(k)) classes.delete(k); }
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
        for (const k of [...classes]) if (/^a-\d/.test(k)) classes.delete(k);
        classes.add('a-' + c);
      } else if (c === 38 || c === 48) {
        // 256/truecolor: approximate to the nearest basic colour for foreground, skip background
        if (codes[i + 1] === 5) {
          if (c === 38) { const n = codes[i + 2]; classes.add('a-' + (n < 8 ? 30 + n : n < 16 ? 82 + n : 37)); }
          i += 2;
        } else if (codes[i + 1] === 2) i += 4;
      }
    }
  }
  flush(line.slice(last));
  void open;
  return out;
}

// ---------- LED rings ----------
// Round buttons use the CSS rotate() ring. Square buttons get a rounded-square
// frame: LEDs walk clockwise from 12 o'clock along the perimeter.
export function placeLeds(leds, shape, half) {
  const n = leds.length;
  leds.forEach((led, i) => {
    if (shape !== 'square') { led.style.transform = ''; return; }
    const side = 2 * half;
    let d = (i / n) * 4 * side;
    let x, y;
    if (d < half) { x = d; y = -half; }
    else if ((d -= half) < side) { x = half; y = -half + d; }
    else if ((d -= side) < side) { x = half - d; y = half; }
    else if ((d -= side) < side) { x = -half; y = half - d; }
    else { d -= side; x = -half + d; y = -half; }
    if (Math.abs(Math.abs(x) - half) < 0.01 && Math.abs(Math.abs(y) - half) < 0.01) { x *= 0.84; y *= 0.84; } // soften corners
    led.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  });
}

// ---------- time ----------
export function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min ago`;
  const hr = m / 60;
  if (hr < 24) return `${Math.round(hr)}h ago`;
  const d = hr / 24;
  if (d < 30) return `${Math.round(d)}d ago`;
  return new Date(ts).toLocaleDateString();
}
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
export function dur(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
export function hostOf(url) {
  try { return new URL(/^https?:/.test(url) ? url : 'https://' + url).host; } catch { return url; }
}
