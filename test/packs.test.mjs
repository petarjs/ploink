import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validatePack, parsePack, cleanSoundStep, loadPackDir, packCatalog, resolvePack, installPackFile, removePackFile,
  DEFAULT_PACK_ID, MAX_PACK_BYTES,
} from '../main/packs.mjs';
import { loadPro } from '../main/extensions.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploink-packs-'));
const base = { format: 1, id: 'com.you.neon', name: 'Neon' };

test('a minimal pack gets every default', () => {
  const { pack, warnings } = validatePack(base);
  assert.deepEqual(warnings, []);
  assert.equal(pack.cap.material, 'gloss');
  assert.equal(pack.led.style, 'dots');
  assert.equal(pack.readout.style, 'vfd');
  assert.equal(pack.panel.style, 'plain');
  assert.equal(pack.bezel.style, 'steel');
  assert.equal(pack.tier, 'free');
  assert.deepEqual(pack.tokens, {});
  assert.deepEqual(pack.sounds, {});
});

test('rejects things that are not packs', () => {
  assert.match(validatePack(null).error, /JSON object/);
  assert.match(validatePack([]).error, /JSON object/);
  assert.match(validatePack({ ...base, format: 2 }).error, /newer Ploink/);
  assert.match(validatePack({ ...base, format: '1' }).error, /format/);
  assert.match(validatePack({ ...base, id: 'Has Spaces' }).error, /id/);
  assert.match(validatePack({ ...base, name: '   ' }).error, /name/);
  assert.match(parsePack('{nope').error, /JSON/);
  assert.match(parsePack(JSON.stringify({ ...base, description: 'x'.repeat(MAX_PACK_BYTES) })).error, /64 KB/);
});

test('tokens: only allowlisted properties with plain values', () => {
  const { pack, warnings } = validatePack({
    ...base,
    tokens: {
      '--vfd': '#ff3df2',
      '--ink': 'rgba(255, 255, 255, 0.9)',
      '--chassis': 'url(https://evil.example/x.png)',
      '--bay-top': 'red; background: url(x)',
      '--hole': '12px',
      'background': '#000',
      '--brand': 'hsl(20 100% 50%)',
    },
  });
  assert.deepEqual(pack.tokens, { '--vfd': '#ff3df2', '--ink': 'rgba(255, 255, 255, 0.9)', '--hole': '12px', '--brand': 'hsl(20 100% 50%)' });
  assert.equal(warnings.length, 3);
});

test('unknown building blocks fall back to defaults with a warning', () => {
  const { pack, warnings } = validatePack({ ...base, cap: { material: 'jelly' }, led: { style: 'lasers' }, readout: { style: 'segments' }, panel: { style: 'wood' } });
  assert.equal(pack.cap.material, 'gloss');
  assert.equal(pack.led.style, 'dots');
  assert.equal(pack.readout.style, 'vfd');
  assert.equal(pack.panel.style, 'wood');
  assert.equal(warnings.length, 3);
});

test('palettes keep only colours, up to the limit', () => {
  const { pack } = validatePack({ ...base, cap: { material: 'ornament', palette: ['#c8102e', 'javascript:alert(1)', '#1f7a3a', '#fff', 'rgb(1,2,3)', '#d4a017', '#000000', '#111111', '#222222', '#333333'] }, led: { style: 'bulbs', palette: ['#f00', '#0f0', '#00f', '#ff0', '#0ff'] } });
  assert.deepEqual(pack.cap.palette, ['#c8102e', '#1f7a3a', '#d4a017', '#000000', '#111111', '#222222'], 'cap colours must be #rrggbb');
  assert.equal(pack.led.palette.length, 4);
});

test('sound steps are clamped to safe ranges', () => {
  const s = cleanSoundStep({ kind: 'tone', type: 'square', freq: 99999, peak: 5, at: 2.4, attack: 0.5, decay: 2.5, detune: 9999, extra: 'x' });
  assert.equal(s.freq, 12000);
  assert.equal(s.peak, 0.6);
  assert.equal(s.detune, 1200);
  assert.ok(s.at + s.attack + s.decay <= 3.0001);
  assert.equal(s.extra, undefined);
  assert.equal(cleanSoundStep({ kind: 'sample', url: 'x' }), null);
  assert.equal(cleanSoundStep({ kind: 'noise', type: 'weird' }).type, 'bandpass');
  assert.equal(cleanSoundStep({ kind: 'tone', type: 'weird' }).type, 'sine');
});

test('sounds: known events only, null means silence, at most 16 steps', () => {
  const step = { kind: 'tone', freq: 440 };
  const { pack, warnings } = validatePack({ ...base, sounds: { success: Array(20).fill(step), launch: null, explode: [step], press: 'loud' } });
  assert.equal(pack.sounds.success.length, 16);
  assert.deepEqual(pack.sounds.launch, []);
  assert.equal(pack.sounds.explode, undefined);
  assert.equal(pack.sounds.press, undefined);
  assert.ok(warnings.some((w) => /explode/.test(w)));
});

test('effects and words', () => {
  const { pack } = validatePack({
    ...base,
    effects: { success: { kind: 'snow', palette: ['#fff'], count: 999 }, fail: null, boom: { kind: 'confetti' } },
    words: { SHIPPED: 'goal!', READY: 'this one is far too long', FAILED: '<script>', IDLE: 'face-off' },
  });
  assert.deepEqual(pack.effects.success, { kind: 'snow', palette: ['#fff'], count: 200 });
  assert.deepEqual(pack.effects.fail, { kind: 'none' });
  assert.equal(pack.effects.boom, undefined);
  assert.deepEqual(pack.words, { SHIPPED: 'GOAL!', READY: 'THIS ONE IS FA', IDLE: 'FACE-OFF' });
});

test('the built-in packs are valid and include the default', () => {
  const packs = loadPackDir(path.join(ROOT, 'packs'));
  assert.ok(packs.find((p) => p.id === DEFAULT_PACK_ID), 'mission control ships with the app');
  for (const file of fs.readdirSync(path.join(ROOT, 'packs'))) {
    const res = parsePack(fs.readFileSync(path.join(ROOT, 'packs', file), 'utf8'));
    assert.ok(res.pack, `${file}: ${res.error}`);
    assert.deepEqual(res.warnings, [], `${file} has warnings`);
    assert.equal(res.pack.tier, 'free');
  }
});

test('catalog order, sources and id protection', () => {
  const free = validatePack({ format: 1, id: DEFAULT_PACK_ID, name: 'Mission Control' }).pack;
  const proPack = { format: 1, id: 'dev.ploink.arcade', name: 'Arcade', tier: 'pro' };
  const fake = validatePack({ format: 1, id: 'dev.ploink.fake', name: 'Fake' }).pack;
  const mine = validatePack({ format: 1, id: 'com.you.neon', name: 'Neon', tier: 'pro' }).pack;
  const cat = packCatalog({ builtin: [free], pro: [proPack], community: [fake, mine] });
  assert.deepEqual(cat.map((p) => [p.id, p.source, p.tier]), [
    [DEFAULT_PACK_ID, 'builtin', 'free'],
    ['dev.ploink.arcade', 'pro', 'pro'],
    ['com.you.neon', 'community', 'free'],
  ]);
});

test('resolvePack falls back to the default for locked or missing packs', () => {
  const cat = packCatalog({
    builtin: [validatePack({ format: 1, id: DEFAULT_PACK_ID, name: 'Mission Control' }).pack],
    pro: [{ format: 1, id: 'dev.ploink.arcade', name: 'Arcade' }],
  });
  assert.equal(resolvePack(cat, 'dev.ploink.arcade', { pro: false }).id, DEFAULT_PACK_ID);
  assert.equal(resolvePack(cat, 'dev.ploink.arcade', { pro: true }).id, 'dev.ploink.arcade');
  assert.equal(resolvePack(cat, 'nope', { pro: true }).id, DEFAULT_PACK_ID);
  assert.equal(resolvePack(cat, undefined).id, DEFAULT_PACK_ID);
});

test('installing a community pack', () => {
  const user = path.join(tmp, 'user-packs');
  const src = path.join(tmp, 'neon.ploinkpack');
  fs.writeFileSync(src, JSON.stringify({ ...base, tokens: { '--vfd': '#0ff' } }));
  const res = installPackFile(src, user);
  assert.equal(res.pack.id, 'com.you.neon');
  assert.deepEqual(loadPackDir(user).map((p) => p.id), ['com.you.neon']);

  const official = path.join(tmp, 'official.ploinkpack');
  fs.writeFileSync(official, JSON.stringify({ format: 1, id: 'dev.ploink.sneaky', name: 'Sneaky' }));
  assert.match(installPackFile(official, user).error, /reserved/);
  assert.match(installPackFile(path.join(tmp, 'x.json'), user).error, /\.ploinkpack/);

  assert.equal(removePackFile('com.you.neon', user), true);
  assert.deepEqual(loadPackDir(user), []);
  assert.equal(removePackFile('../../etc', user), false);
});

test('the Pro hook returns null without a pro folder and loads one when present', async () => {
  assert.equal(await loadPro(path.join(tmp, 'no-such-app')), null);
  const app = path.join(tmp, 'app');
  fs.mkdirSync(path.join(app, 'pro'), { recursive: true });
  fs.writeFileSync(path.join(app, 'pro', 'index.mjs'), "export const version = '1.2.3';\nexport const packs = [{ format: 1, id: 'dev.ploink.test', name: 'Test' }];\n");
  const pro = await loadPro(app);
  assert.equal(pro.version, '1.2.3');
  assert.equal(pro.packs.length, 1);
  assert.equal(pro.activate, null);
});
