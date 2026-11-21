// Fetch the best icon a website offers (apple-touch-icon > svg > large png > favicon.ico).
const TIMEOUT_MS = 7000;
const MAX_BYTES = 768 * 1024;

async function get(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Ploink/0.1', Accept: accept },
    });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function sniffMime(buf, header) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01) return 'image/x-icon';
  if (buf.slice(0, 4).toString() === 'RIFF') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  const head = buf.slice(0, 256).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  if (header && header.startsWith('image/')) return header.split(';')[0];
  return null;
}

async function fetchImage(url) {
  const res = await get(url, 'image/*,*/*;q=0.5');
  if (!res) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) return null;
  const mime = sniffMime(buf, res.headers.get('content-type'));
  if (!mime) return null;
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function parseIcons(html, base) {
  const icons = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase() || '';
    if (!/\bicon\b|apple-touch-icon|mask-icon/.test(rel)) continue;
    if (rel.includes('mask-icon')) continue; // monochrome safari pinned icons look wrong
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const sizes = (tag.match(/\bsizes\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    let size = parseInt(sizes, 10) || 0;
    if (sizes === 'any') size = 512;
    let score = size;
    if (rel.includes('apple-touch-icon')) score += 400;
    if (type.includes('svg') || /\.svg(\?|$)/i.test(href)) score += 300;
    try {
      icons.push({ url: new URL(href, base).href, score });
    } catch { /* bad href */ }
  }
  return icons.sort((a, b) => b.score - a.score);
}

export async function fetchFavicon(rawUrl) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;

  const candidates = [];
  const page = await get(url.href, 'text/html,*/*;q=0.5');
  if (page) {
    const html = (await page.text()).slice(0, 400_000);
    candidates.push(...parseIcons(html, page.url || url.href).map((i) => i.url));
  }
  candidates.push(new URL('/apple-touch-icon.png', url).href, new URL('/favicon.svg', url).href, new URL('/favicon.ico', url).href);

  for (const c of [...new Set(candidates)].slice(0, 8)) {
    const data = await fetchImage(c);
    if (data) return data;
  }
  return null;
}
