#!/usr/bin/env node
// Serves the renderer in a normal browser with a mock bridge, for UI work without Electron.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPackDir, packCatalog } from '../main/packs.mjs';
import { loadPro } from '../main/extensions.mjs';

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(appRoot, 'renderer');

// the real pack files, so the mock bridge can show them (Pro ones only when pro/ is present)
async function packsJson() {
  const pro = await loadPro(appRoot);
  return JSON.stringify({ packs: packCatalog({ builtin: loadPackDir(path.join(appRoot, 'packs')), pro: pro?.packs || [] }), proBuild: !!pro, proVersion: pro?.version || '' });
}
const port = Number(process.env.PORT) || 5178;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/__packs.json') { packsJson().then((body) => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body)); return; }
  const file = path.join(root, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Ploink UI preview: http://127.0.0.1:${port}`));
