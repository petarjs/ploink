import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { License, parseKey, maskEmail, GUMROAD_VERIFY_URL, FOUNDER_VERIFY_URL, GUMROAD_PRODUCT_ID, OFFLINE_GRACE_MS, RECHECK_MS } from '../main/license.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploink-license-'));
const KEY = '85DB562A-C11D4B06-A2335A6B-8C079166';
const CODE = 'ABCDEFGHJKMNPQR2';

const reply = (status, body) => ({ status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
const notJson = (status) => ({ status, json: async () => { throw new Error('not json'); } });

/** A fake fetch: routes by URL, records every call. */
function fakeNet(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init.body);
    calls.push({ url, body });
    const r = routes[url];
    if (!r) throw new Error('offline');
    return typeof r === 'function' ? r(body) : r;
  };
  return { fetchImpl, calls };
}

const gumroadOk = (purchase = {}, uses = 1) => reply(200, { success: true, uses, purchase: { email: 'founder@example.com', sale_id: 's1', refunded: false, disputed: false, chargebacked: false, ...purchase } });
const newDir = () => fs.mkdtempSync(path.join(tmp, 'data-'));

test('parseKey recognises license keys and founder codes', () => {
  assert.deepEqual(parseKey(` ${KEY.toLowerCase()} `), { kind: 'gumroad', key: KEY });
  assert.deepEqual(parseKey('abcd-efgh-jkmn-pqr2'), { kind: 'founder', key: CODE });
  assert.equal(parseKey('ABCDEFGHIJKLMNOP'), null, 'I, L and O never appear in founder codes');
  assert.equal(parseKey('hello'), null);
  assert.equal(parseKey(''), null);
});

test('maskEmail hides most of the address', () => {
  assert.equal(maskEmail('founder@example.com'), 'f••••••@example.com');
  assert.equal(maskEmail('ab@x.io'), 'a••@x.io');
  assert.equal(maskEmail('nope'), '');
});

test('activating a Gumroad key counts a use, stores it 0600 and asks ploink.dev for the founder number', async () => {
  const dir = newDir();
  const net = fakeNet({ [GUMROAD_VERIFY_URL]: gumroadOk(), [FOUNDER_VERIFY_URL]: reply(200, { ok: true, founder: 7 }) });
  const lic = new License({ dir, fetchImpl: net.fetchImpl });
  const res = await lic.activate(KEY);
  assert.equal(res.ok, true);
  assert.equal(res.license.pro, true);
  assert.equal(res.license.founder, 7);
  assert.equal(res.license.keyHint, '9166');
  assert.equal(JSON.stringify(res.license).includes(KEY), false, 'the view never shows the full key');
  assert.deepEqual(net.calls[0].body, { product_id: GUMROAD_PRODUCT_ID, license_key: KEY, increment_uses_count: 'true' });
  assert.deepEqual(net.calls[1].body, { key: KEY });
  const file = path.join(dir, 'ploink-license.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(new License({ dir, fetchImpl: net.fetchImpl }).active, true, 'survives a restart');
});

test('activation still works when ploink.dev is down (no founder number)', async () => {
  const net = fakeNet({ [GUMROAD_VERIFY_URL]: gumroadOk() });
  const lic = new License({ dir: newDir(), fetchImpl: net.fetchImpl });
  const res = await lic.activate(KEY);
  assert.equal(res.license.pro, true);
  assert.equal(res.license.founder, null);
});

test('refuses unknown, refunded and over-used keys', async () => {
  let lic = new License({ dir: newDir(), fetchImpl: fakeNet({ [GUMROAD_VERIFY_URL]: reply(404, { success: false, message: 'That license does not exist for the provided product.' }) }).fetchImpl });
  assert.match((await lic.activate(KEY)).error, /does not know/);
  assert.equal(lic.active, false);

  lic = new License({ dir: newDir(), fetchImpl: fakeNet({ [GUMROAD_VERIFY_URL]: gumroadOk({ refunded: true }) }).fetchImpl });
  assert.match((await lic.activate(KEY)).error, /refunded/);

  lic = new License({ dir: newDir(), fetchImpl: fakeNet({ [GUMROAD_VERIFY_URL]: gumroadOk({}, 6) }).fetchImpl });
  assert.match((await lic.activate(KEY)).error, /5 Macs/);
  assert.equal(lic.active, false);
});

test('network trouble on activation is an error, not a lock', async () => {
  const lic = new License({ dir: newDir(), fetchImpl: fakeNet({}).fetchImpl });
  assert.match((await lic.activate(KEY)).error, /Could not reach Gumroad/);
  const lic2 = new License({ dir: newDir(), fetchImpl: fakeNet({ [GUMROAD_VERIFY_URL]: notJson(502) }).fetchImpl });
  assert.match((await lic2.activate(KEY)).error, /did not answer/);
  assert.match((await lic.activate('nonsense')).error, /not a license key/);
});

test('founder codes are checked with ploink.dev', async () => {
  const net = fakeNet({ [FOUNDER_VERIFY_URL]: (body) => reply(200, body.key === CODE ? { ok: true, founder: 1 } : { ok: false }) });
  const lic = new License({ dir: newDir(), fetchImpl: net.fetchImpl });
  const res = await lic.activate('abcd efgh jkmn pqr2');
  assert.equal(res.license.pro, true);
  assert.equal(res.license.kind, 'founder');
  assert.equal(res.license.founder, 1);
  assert.equal(net.calls.length, 1);
  assert.match((await new License({ dir: newDir(), fetchImpl: net.fetchImpl }).activate('ZZZZZZZZZZZZZZZZ')).error, /does not know that code/);
});

test('a missing ploink.dev endpoint (404 page, not JSON) is treated as offline', async () => {
  const lic = new License({ dir: newDir(), fetchImpl: fakeNet({ [FOUNDER_VERIFY_URL]: notJson(404) }).fetchImpl });
  assert.match((await lic.activate(CODE)).error, /did not answer/);
});

test('refresh: skips recent checks, keeps Pro when offline, locks on a refund', async () => {
  let t = 1_000_000;
  let route = gumroadOk();
  const net = fakeNet({ [GUMROAD_VERIFY_URL]: () => route, [FOUNDER_VERIFY_URL]: reply(200, { ok: true, founder: 3 }) });
  const dir = newDir();
  const lic = new License({ dir, fetchImpl: net.fetchImpl, now: () => t });
  await lic.activate(KEY);
  const before = net.calls.length;

  await lic.refresh();
  assert.equal(net.calls.length, before, 'no network call inside 24 hours');

  t += RECHECK_MS + 1;
  route = notJson(503);
  let r = await lic.refresh();
  assert.equal(r.offline, true);
  assert.equal(lic.active, true, 'a server error keeps Pro on');

  route = gumroadOk({ refunded: true });
  r = await lic.refresh();
  assert.equal(r.changed, true);
  assert.equal(lic.active, false);
  assert.equal(r.license.status, 'revoked');
  assert.match(r.license.message, /refunded/);
  const g = net.calls.filter((c) => c.url === GUMROAD_VERIFY_URL).at(-1);
  assert.equal(g.body.increment_uses_count, 'false', 'routine checks never count a use');

  route = gumroadOk();
  r = await lic.refresh();
  assert.equal(r.changed, true, 'an un-refunded key comes back');
  assert.equal(lic.active, true);
});

test('Pro turns off after 30 days without a good check, and back on after one', async () => {
  let t = 5_000_000;
  let online = true;
  const net = fakeNet({});
  const fetchImpl = async (url, init) => {
    if (!online) throw new Error('offline');
    return url === GUMROAD_VERIFY_URL ? gumroadOk() : net.fetchImpl(url, init);
  };
  const lic = new License({ dir: newDir(), fetchImpl, now: () => t });
  await lic.activate(KEY);
  online = false;
  t += OFFLINE_GRACE_MS - 1000;
  await lic.refresh();
  assert.equal(lic.active, true);
  t += 2000;
  await lic.refresh();
  assert.equal(lic.active, false);
  assert.equal(lic.view().status, 'stale');
  online = true;
  await lic.refresh();
  assert.equal(lic.active, true);
});

test('deactivate removes the stored key', async () => {
  const dir = newDir();
  const lic = new License({ dir, fetchImpl: fakeNet({ [GUMROAD_VERIFY_URL]: gumroadOk() }).fetchImpl });
  await lic.activate(KEY);
  assert.deepEqual(lic.deactivate(), { pro: false, status: 'none' });
  assert.equal(fs.existsSync(path.join(dir, 'ploink-license.json')), false);
  assert.equal(new License({ dir }).active, false);
});

test('checks run one at a time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (url === GUMROAD_VERIFY_URL) return gumroadOk();
    throw new Error('offline');
  };
  const lic = new License({ dir: newDir(), fetchImpl });
  await Promise.all([lic.activate(KEY), lic.refresh({ force: true }), lic.refresh({ force: true })]);
  assert.equal(maxInFlight, 1);
});
