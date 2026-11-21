// Look inside a project folder and guess: name, deploy commands, website URL and icon.
import fs from 'node:fs';
import path from 'node:path';

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export function fileToDataUrl(file, maxBytes = 768 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime) return null;
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

const ICON_CANDIDATES = [
  'public/apple-touch-icon.png', 'public/apple-icon.png', 'public/icon.svg', 'public/logo.svg', 'public/favicon.svg',
  'public/icon-512.png', 'public/icon-192.png', 'public/android-chrome-512x512.png', 'public/android-chrome-192x192.png',
  'public/icon.png', 'public/logo.png', 'public/favicon.png', 'public/favicon.ico',
  'app/apple-icon.png', 'app/icon.svg', 'app/icon.png', 'app/favicon.ico',
  'src/app/apple-icon.png', 'src/app/icon.svg', 'src/app/icon.png', 'src/app/favicon.ico',
  'static/apple-touch-icon.png', 'static/favicon.svg', 'static/favicon.png', 'static/favicon.ico',
  'src/assets/logo.svg', 'src/assets/icon.png', 'assets/icon.png', 'assets/logo.png', 'assets/logo.svg',
  'build/icon.png', 'resources/icon.png', 'icon.png', 'logo.svg', 'logo.png', 'favicon.ico',
];

export function findLocalIcon(dir) {
  const roots = [dir];
  // monorepos: also peek into apps/* and packages/web
  for (const sub of ['apps', 'packages']) {
    const p = path.join(dir, sub);
    if (exists(p)) {
      try {
        for (const name of fs.readdirSync(p)) roots.push(path.join(p, name));
      } catch { /* ignore */ }
    }
  }
  for (const root of roots) {
    for (const rel of ICON_CANDIDATES) {
      const data = fileToDataUrl(path.join(root, rel));
      if (data) return data;
    }
  }
  return null;
}

function packageManager(dir) {
  if (exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) return 'bun';
  if (exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

const titleCase = (s) => s.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

function labelForScript(name) {
  const rest = name.split(':').slice(1).join(':');
  if (rest) return rest.replace(/^(to-|on-)/, '').slice(0, 14);
  return name === 'deploy' ? 'deploy' : name;
}

function findUrl(dir, pkg) {
  if (pkg?.homepage && /^https?:\/\//.test(pkg.homepage) && !/github\.com/.test(pkg.homepage)) return pkg.homepage;
  const cname = read(path.join(dir, 'CNAME')) || read(path.join(dir, 'public/CNAME')) || read(path.join(dir, 'static/CNAME'));
  if (cname && cname.trim() && !cname.includes(' ')) return 'https://' + cname.trim().split('\n')[0];
  for (const f of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']) {
    const m = read(path.join(dir, f))?.match(/site:\s*['"`](https?:\/\/[^'"`]+)['"`]/);
    if (m) return m[1];
  }
  for (const f of ['next-sitemap.config.js', 'next-sitemap.config.cjs', 'next-sitemap.config.mjs']) {
    const m = read(path.join(dir, f))?.match(/siteUrl:\s*['"`](https?:\/\/[^'"`]+)['"`]/);
    if (m) return m[1];
  }
  for (const f of ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']) {
    const txt = read(path.join(dir, f));
    if (!txt) continue;
    const m = txt.match(/pattern["']?\s*[:=]\s*["']([a-z0-9.-]+\.[a-z]{2,})(\/[^"']*)?["']/i);
    if (m) return 'https://' + m[1];
  }
  const fly = read(path.join(dir, 'fly.toml'))?.match(/^app\s*=\s*["']([^"']+)["']/m);
  if (fly) return `https://${fly[1]}.fly.dev`;
  return '';
}

export function detectProject(dir) {
  const result = { cwd: dir, name: path.basename(dir), commands: [], url: '', icon: null, hints: [] };
  if (!exists(dir)) return { ...result, error: 'Folder not found' };

  let pkg = null;
  try { pkg = JSON.parse(read(path.join(dir, 'package.json')) || 'null'); } catch { pkg = null; }
  if (pkg?.name) result.name = titleCase(String(pkg.name).replace(/^@[^/]+\//, ''));
  else result.name = titleCase(result.name);

  const pm = packageManager(dir);
  const run = (script) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`);
  const add = (label, cmd, why) => {
    if (!result.commands.some((c) => c.cmd === cmd)) result.commands.push({ label, cmd });
    if (why) result.hints.push(why);
  };

  const scripts = pkg?.scripts || {};
  const deployish = Object.keys(scripts).filter((s) => /^(deploy|ship|release|publish)(:|$)/.test(s));
  // plain "deploy" first, then variants like deploy:prod, deploy:staging
  deployish.sort((a, b) => (a === 'deploy' ? -1 : b === 'deploy' ? 1 : a.localeCompare(b)));
  for (const s of deployish.slice(0, 4)) add(labelForScript(s), run(s), `package.json script "${s}"`);

  if (!result.commands.length) {
    const mk = read(path.join(dir, 'Makefile'));
    if (mk && /^deploy:/m.test(mk)) add('deploy', 'make deploy', 'Makefile target "deploy"');
    if (exists(path.join(dir, 'fly.toml'))) add('fly', 'fly deploy', 'fly.toml');
    if (exists(path.join(dir, 'wrangler.toml')) || exists(path.join(dir, 'wrangler.jsonc')) || exists(path.join(dir, 'wrangler.json'))) add('cloudflare', 'npx wrangler deploy', 'wrangler config');
    if (exists(path.join(dir, 'vercel.json')) || exists(path.join(dir, '.vercel'))) {
      add('prod', 'vercel deploy --prod', 'Vercel project');
      add('preview', 'vercel deploy', null);
    }
    if (exists(path.join(dir, 'netlify.toml'))) add('netlify', 'netlify deploy --prod', 'netlify.toml');
    if (exists(path.join(dir, 'firebase.json'))) add('firebase', 'firebase deploy', 'firebase.json');
    if (exists(path.join(dir, 'deploy.sh'))) add('deploy', './deploy.sh', 'deploy.sh');
  }

  result.url = findUrl(dir, pkg);
  result.icon = findLocalIcon(dir);
  result.actions = suggestActions(dir, { scripts, run, url: result.url });
  return result;
}

// The health check every site gets. curl prints "200 · 0.21s"; -f makes 4xx/5xx a failure.
export const HEALTH_CMD = `curl -fsSL -o /dev/null --max-time 15 -w '%{http_code} · %{time_total}s' "$PLOINK_URL"`;

/**
 * Action keys worth suggesting for a folder: a site health check (also run after every deploy)
 * and the dev server. Agents may press the health check; nothing else by default.
 */
export function suggestActions(dir, { scripts = {}, run = (s) => `npm run ${s}`, url = '' } = {}) {
  const out = [];
  if (url) out.push({ label: 'health', kind: 'check', cmd: HEALTH_CMD, agents: true, afterDeploy: true });
  const dev = ['dev', 'develop', 'serve', 'start:dev'].find((s) => scripts[s]);
  if (dev) out.push({ label: 'dev', kind: 'service', cmd: run(dev), agents: false });
  return out;
}
