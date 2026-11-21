#!/usr/bin/env node
// Builds the official Ploink DMG. It copies the private ploink-pro module into pro/ (git-ignored),
// checks every pack, runs the tests, then runs electron-builder. A build without pro/ is the free app.
//
//   npm run release                 official build with Pro (unsigned until there is a Developer ID)
//   npm run release -- --pro-only   only refresh pro/, for `npm start` and `npm run preview`
//   npm run release -- --free       build without Pro, exactly like a build from public source
//
// The Pro source folder is $PLOINK_PRO_DIR, or ~/ploink-pro.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const proSrc = path.resolve(process.env.PLOINK_PRO_DIR || path.join(os.homedir(), 'ploink-pro'));
const proDest = path.join(root, 'pro');
const args = new Set(process.argv.slice(2));
const fail = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const step = (msg) => console.log(`\n▸ ${msg}`);

function syncPro() {
  if (!fs.existsSync(path.join(proSrc, 'index.mjs'))) fail(`No Pro module at ${proSrc}. Set PLOINK_PRO_DIR, or use --free.`);
  fs.rmSync(proDest, { recursive: true, force: true });
  fs.cpSync(proSrc, proDest, {
    recursive: true,
    // only what the app loads: index.mjs, package.json and packs/
    filter: (src) => !/[/\\](\.git|node_modules|\.DS_Store|check\.mjs|README\.md)([/\\]|$)/.test(src),
  });
  console.log(`  copied ${proSrc} → pro/`);
}

async function checkPacks() {
  const { validatePack, loadPackDir } = await import(pathToFileURL(path.join(root, 'main/packs.mjs')).href);
  const { loadPro } = await import(pathToFileURL(path.join(root, 'main/extensions.mjs')).href);
  const pro = await loadPro(root);
  const all = [...loadPackDir(path.join(root, 'packs')).map((p) => ['free', p]), ...(pro?.packs || []).map((p) => ['pro', p])];
  let bad = 0;
  for (const [tier, p] of all) {
    const res = validatePack(p);
    const problems = res.error ? [res.error] : res.warnings;
    if (problems.length) { bad++; console.log(`  ✗ ${p.id}: ${problems.join('; ')}`); } else console.log(`  ✓ ${tier.padEnd(4)} ${res.pack.name}`);
  }
  if (bad) fail(`${bad} pack(s) have problems.`);
  return pro;
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (args.has('--free')) {
  step('Free build: removing pro/');
  fs.rmSync(proDest, { recursive: true, force: true });
} else {
  step(`Copying Pro ${args.has('--pro-only') ? '' : 'into the build '}from ${proSrc}`);
  syncPro();
}

step('Checking packs');
const pro = await checkPacks();
if (args.has('--pro-only')) { console.log(`\n✓ pro/ is ready (Pro ${pro?.version || '?'}). npm start and npm run preview now show the Pro packs.\n`); process.exit(0); }

step('Running tests');
execFileSync('npm', ['test'], { cwd: root, stdio: 'inherit' });

step(`Building Ploink ${pkg.version} DMG (${pro ? `with Pro ${pro.version}` : 'free'})`);
execFileSync('npx', ['electron-builder', '--mac', 'dmg'], { cwd: root, stdio: 'inherit' });

const dist = path.join(root, 'dist');
const built = fs.readdirSync(dist).filter((n) => n.endsWith('.dmg') && n.includes(pkg.version)).map((n) => path.join(dist, n));
if (!built.length) fail('electron-builder finished, but no DMG for this version is in dist/.');
const dmg = built.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const upload = path.join(dist, 'Ploink.dmg');
fs.copyFileSync(dmg, upload);
const bytes = fs.statSync(upload).size;
const sha = crypto.createHash('sha256').update(fs.readFileSync(upload)).digest('hex');

console.log(`
✓ Built ${path.relative(root, dmg)} and copied it to dist/Ploink.dmg
  size    ${(bytes / 1e6).toFixed(0)} MB
  sha256  ${sha}
  Pro     ${pro ? `included (${pro.version})` : 'not included'}

Next (each needs your OK, nothing here was published):
  1. Upload dist/Ploink.dmg to a GitHub release v${pkg.version} on petarjs/ploink.
  2. Point BETA in site/src/founders/shared.js at the new release.
  3. Email founders the link and their founder code.
`);
