// Ploink Pro license. Two ways in:
//   - a Gumroad license key, checked with Gumroad's public verify endpoint (no token needed),
//   - a founder code from ploink.dev, for founders who bought before license keys existed.
// The result is cached on disk. Pro keeps working offline for 30 days after the last good check,
// and turns off only when a check gives a definite "no" (unknown key, refund, dispute, chargeback).
import fs from 'node:fs';
import path from 'node:path';

export const GUMROAD_PRODUCT_ID = 'PzEwIo6nCmFGh8LHJw5hmA==';
export const GUMROAD_VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';
export const FOUNDER_VERIFY_URL = 'https://ploink.dev/api/pro/verify';
export const OFFLINE_GRACE_MS = 30 * 86400e3;
export const RECHECK_MS = 24 * 3600e3;
export const MAX_USES = 5;
const TIMEOUT_MS = 10000;

// founder codes use this alphabet (no 0/O, 1/I/L), see site/src/founders/server.js
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Recognise a Gumroad license key or a founder code. Returns { kind, key } or null. */
export function parseKey(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^[0-9A-F]{8}(-[0-9A-F]{8}){3}$/.test(s)) return { kind: 'gumroad', key: s };
  const code = s.replace(/[^A-Z0-9]/g, '');
  if (code.length === 16 && [...code].every((c) => CODE_ALPHABET.includes(c))) return { kind: 'founder', key: code };
  return null;
}

export function maskEmail(email) {
  const m = String(email || '').match(/^([^@]{1,64})@(.+)$/);
  if (!m) return '';
  return `${m[1][0]}${'•'.repeat(Math.min(6, Math.max(2, m[1].length - 1)))}@${m[2]}`;
}

const transient = (message) => ({ transient: true, message });
const retryable = (status) => status >= 500 || status === 429 || status === 408;

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

export class License {
  constructor({ dir, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.file = path.join(dir, 'ploink-license.json');
    this.fetch = fetchImpl;
    this.now = now;
    this.state = this.read();
    this.busy = null;
  }

  read() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s && typeof s.key === 'string' && (s.kind === 'gumroad' || s.kind === 'founder') && typeof s.checkedAt === 'number') return s;
    } catch { /* no license yet */ }
    return null;
  }

  save() {
    if (!this.state) { try { fs.unlinkSync(this.file); } catch { /* already gone */ } return; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** True when Pro features may be used right now. */
  get active() {
    const s = this.state;
    return !!s && s.status === 'active' && this.now() - s.checkedAt < OFFLINE_GRACE_MS;
  }

  /** What the UI may show. Never includes the full key. */
  view() {
    const s = this.state;
    if (!s) return { pro: false, status: 'none' };
    const stale = s.status === 'active' && this.now() - s.checkedAt >= OFFLINE_GRACE_MS;
    return {
      pro: this.active,
      status: stale ? 'stale' : s.status,
      kind: s.kind,
      founder: s.founder || null,
      email: maskEmail(s.email),
      keyHint: s.key.slice(-4),
      test: !!s.test,
      activatedAt: s.activatedAt,
      checkedAt: s.checkedAt,
      message: s.message || '',
    };
  }

  async post(url, body, json) {
    return this.fetch(url, {
      method: 'POST',
      headers: json ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: json ? JSON.stringify(body) : new URLSearchParams(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async checkGumroad(key, increment) {
    let res;
    try {
      res = await this.post(GUMROAD_VERIFY_URL, { product_id: GUMROAD_PRODUCT_ID, license_key: key, increment_uses_count: String(!!increment) });
    } catch {
      return transient('Could not reach Gumroad. Check your connection and try again.');
    }
    const data = await readJson(res);
    if (retryable(res.status) || !data) return transient(`Gumroad did not answer properly (${res.status}). Try again in a minute.`);
    if (!data.success || !data.purchase) return { ok: false, message: 'Gumroad does not know that license key. Copy it from your Gumroad receipt.' };
    const p = data.purchase;
    if (p.refunded || p.chargebacked || p.disputed) return { ok: false, message: 'That purchase was refunded or disputed, so Pro is off.' };
    return { ok: true, uses: Number(data.uses) || 0, email: p.email || '', test: !!p.test };
  }

  async checkFounder(key) {
    let res;
    try {
      res = await this.post(FOUNDER_VERIFY_URL, { key }, true);
    } catch {
      return transient('Could not reach ploink.dev. Check your connection and try again.');
    }
    const data = await readJson(res);
    if (retryable(res.status) || !data || typeof data.ok !== 'boolean') return transient(`ploink.dev did not answer properly (${res.status}). Try again in a minute.`);
    if (!data.ok) return { ok: false, message: 'ploink.dev does not know that code, or the purchase was refunded.' };
    return { ok: true, founder: Number(data.founder) > 0 ? Number(data.founder) : null };
  }

  check({ kind, key }, { increment = false } = {}) {
    return kind === 'gumroad' ? this.checkGumroad(key, increment) : this.checkFounder(key);
  }

  /** Best effort: ploink.dev knows the founder number for license keys too. */
  async founderNumber(key) {
    const r = await this.checkFounder(key).catch(() => null);
    return r?.ok ? r.founder : null;
  }

  /** Check a key or code for the first time and store it. Returns { ok, license } or { error }. */
  activate(raw) {
    return this.exclusive(async () => {
      const parsed = parseKey(raw);
      if (!parsed) return { error: 'That is not a license key or a founder code. License keys look like XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX. Founder codes have 16 letters and digits.' };
      const r = await this.check(parsed, { increment: true });
      if (!r.ok) return { error: r.message };
      if (parsed.kind === 'gumroad' && r.uses > MAX_USES) {
        return { error: `This key is already in use on ${MAX_USES} Macs. Email hey@ploink.dev and we will reset it.` };
      }
      const t = this.now();
      this.state = { kind: parsed.kind, key: parsed.key, email: r.email || '', founder: r.founder || null, test: !!r.test, status: 'active', activatedAt: t, checkedAt: t, message: '' };
      if (parsed.kind === 'gumroad' && !this.state.founder) this.state.founder = await this.founderNumber(parsed.key);
      this.save();
      return { ok: true, license: this.view() };
    });
  }

  /**
   * Check the stored key again (no use is counted). Network trouble keeps Pro on until the
   * 30-day grace runs out. Returns { changed, license }.
   */
  refresh({ force = false } = {}) {
    return this.exclusive(async () => {
      const s = this.state;
      if (!s) return { changed: false, license: this.view() };
      if (!force && s.status === 'active' && this.now() - s.checkedAt < RECHECK_MS) return { changed: false, license: this.view() };
      const before = this.active;
      const r = await this.check(s, { increment: false });
      if (r.transient) return { changed: false, license: this.view(), offline: true };
      s.checkedAt = this.now();
      if (r.ok) {
        s.status = 'active';
        s.message = '';
        if (r.founder) s.founder = r.founder;
        if (s.kind === 'gumroad' && !s.founder) s.founder = await this.founderNumber(s.key);
      } else {
        s.status = 'revoked';
        s.message = r.message;
      }
      this.save();
      return { changed: before !== this.active, license: this.view() };
    });
  }

  deactivate() {
    this.state = null;
    this.save();
    return this.view();
  }

  // one network check at a time
  exclusive(fn) {
    const run = (this.busy || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    this.busy = tail;
    tail.then(() => { if (this.busy === tail) this.busy = null; });
    return run;
  }
}
