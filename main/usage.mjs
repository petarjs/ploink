// AI plan usage gauges: how much of the Claude and Codex (ChatGPT) limits is used.
//
// Claude, main source: `claude -p /usage` prints the plan's windows ("Current week
// (all models): 5% used · resets Nov 28 at 9am"). It is Claude Code's own command, so
// Ploink never touches credentials. Run with no session saved, no MCP servers and no
// user hooks, every 10 minutes and on click. Works for people who only use Claude in
// the desktop app, where the status line never runs.
//
// Claude, optional live source: Claude Code hands its status line command a JSON blob that includes
// `rate_limits` (5-hour and 7-day used % and reset time). Ploink can install a tiny
// status line wrapper that saves ONLY that object to a file, then runs the user's
// original status line so it keeps working. No tokens, cookies or network calls.
//
// Codex: the official `codex app-server` answers `account/rateLimits/read` with the
// plan's windows. Fallback: the newest `token_count` event in ~/.codex/sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { loadShellEnv } from './shellenv.mjs';

export const USAGE_URLS = {
  claude: 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/codex/settings/usage',
};

const HOME = os.homedir();
// tests point this at a temporary file so the real Claude settings are never touched
const CLAUDE_SETTINGS = process.env.PLOINK_CLAUDE_SETTINGS || path.join(HOME, '.claude', 'settings.json');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const CODEX_EVERY_MS = 5 * 60 * 1000;
const CLAUDE_STALE_MS = 60 * 60 * 1000;
const CLAUDE_EVERY_MS = 10 * 60 * 1000;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "Nov 28 at 9am (Europe/Belgrade)" or "3:30pm (Europe/Belgrade)" -> epoch ms (local time)
export function parseResetText(s, now = new Date()) {
  const m = String(s).match(/(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+\d{4})?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return 0;
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const minute = Number(m[4] || 0);
  let d;
  if (m[1] && MONTHS[m[1].toLowerCase()] != null) {
    d = new Date(now.getFullYear(), MONTHS[m[1].toLowerCase()], Number(m[2]), hour, minute);
    if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
  } else {
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

// Lines like "Current session: 23% used · resets 3pm (...)" and
// "Current week (all models): 5% used · resets Nov 28 at 9am (...)"
export function parseClaudeUsage(text, now = new Date()) {
  const windows = [];
  const re = /^\s*Current (session|week)(?:\s*\(([^)]+)\))?:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets\s+(.+))?$/gim;
  for (const m of String(text).matchAll(re)) {
    const session = m[1].toLowerCase() === 'session';
    const scope = (m[2] || '').trim();
    const all = !scope || /all models/i.test(scope);
    windows.push({
      label: session ? '5H' : all ? 'WK' : scope.toUpperCase().slice(0, 8),
      used: Number(m[3]),
      resetsAt: m[4] ? parseResetText(m[4], now) : 0,
      minutes: session ? 300 : 10080,
      extra: !session && !all,
    });
  }
  return windows;
}

function windowLabel(mins) {
  if (mins === 300) return '5H';
  if (mins === 10080) return 'WK';
  if (mins && mins % 1440 === 0) return `${mins / 1440}D`;
  if (mins) return `${Math.round(mins / 60)}H`;
  return '';
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function findBinary(name) {
  const env = await loadShellEnv();
  for (const dir of String(env.PATH || '').split(':')) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  for (const p of [path.join(HOME, '.local/bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export class Usage extends EventEmitter {
  constructor({ dir }) {
    super();
    this.dir = dir;
    this.claude = null;
    this.codex = null;
    this.codexFails = 0;
    this.codexBin = undefined;
    this.claudeBin = undefined;
    this._codexBusy = null;
  }

  get claudeFile() { return path.join(this.dir, 'claude-usage.json'); }
  get wrapperPath() { return path.join(this.dir, 'claude-statusline.sh'); }
  get originalCmdPath() { return path.join(this.dir, 'claude-statusline-original.txt'); }
  get backupPath() { return path.join(this.dir, 'claude-statusline-backup.json'); }

  async start() {
    this.codexBin = await findBinary('codex');
    this.claudeBin = await findBinary('claude');
    this.readClaude();
    if (this.claudeBin) {
      this.pollClaude();
      this._claudeTimer = setInterval(() => this.pollClaude(), CLAUDE_EVERY_MS);
    }
    try {
      fs.watch(this.dir, (_e, file) => { if (file === 'claude-usage.json') { clearTimeout(this._cw); this._cw = setTimeout(() => this.readClaude(), 150); } });
    } catch { /* folder watch not available */ }
    if (this.codexBin) {
      this.pollCodex();
      this._codexTimer = setInterval(() => this.pollCodex(), CODEX_EVERY_MS);
      try {
        // a Codex session writing new events means the numbers just changed
        fs.watch(CODEX_SESSIONS, { recursive: true }, () => {
          clearTimeout(this._sw);
          this._sw = setTimeout(() => this.pollCodex(), 20_000);
        });
      } catch { /* no sessions folder yet */ }
    }
    // re-evaluate staleness and resets once a minute
    this._tick = setInterval(() => this.emit('update', this.snapshot()), 60_000);
  }

  stop() {
    clearInterval(this._claudeTimer);
    clearInterval(this._codexTimer);
    clearInterval(this._tick);
  }

  snapshot() {
    return {
      claude: this.claudeView(),
      codex: this.codexView(),
      urls: USAGE_URLS,
    };
  }

  async refresh() {
    this.readClaude(false);
    await Promise.all([this.pollClaude(), this.pollCodex()]);
    return this.snapshot();
  }

  pollClaude() {
    if (!this.claudeBin) return Promise.resolve();
    if (this._claudeBusy) return this._claudeBusy;
    this._claudeBusy = this.readClaudeCli()
      .then((data) => {
        // a fresher status line snapshot (terminal use) wins over the CLI poll
        if (data && (!this.claude || this.claude.source !== 'Claude Code status line' || data.updatedAt > this.claude.updatedAt + 60_000)) this.claude = data;
        this.claudeFails = data ? 0 : (this.claudeFails || 0) + 1;
      })
      .finally(() => { this._claudeBusy = null; this.emit('update', this.snapshot()); });
    return this._claudeBusy;
  }

  async readClaudeCli() {
    const env = await loadShellEnv();
    return new Promise((resolve) => {
      execFile(
        this.claudeBin,
        ['-p', '/usage', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'project'],
        { env, cwd: os.tmpdir(), timeout: 45_000, maxBuffer: 1024 * 1024 },
        (_err, stdout) => {
          const windows = parseClaudeUsage(stdout);
          resolve(windows.length ? { windows, updatedAt: Date.now(), source: 'Claude Code /usage' } : null);
        },
      );
    });
  }

  // ---------- Claude ----------
  claudeConnected() {
    const s = readJson(CLAUDE_SETTINGS);
    return !!(s?.statusLine?.command && s.statusLine.command.includes(this.wrapperPath));
  }

  readClaude(emit = true) {
    const data = readJson(this.claudeFile);
    if (data?.rate_limits) {
      const rl = data.rate_limits;
      const windows = [];
      if (rl.five_hour) windows.push({ label: '5H', used: Number(rl.five_hour.used_percentage) || 0, resetsAt: (Number(rl.five_hour.resets_at) || 0) * 1000, minutes: 300 });
      if (rl.seven_day) windows.push({ label: 'WK', used: Number(rl.seven_day.used_percentage) || 0, resetsAt: (Number(rl.seven_day.resets_at) || 0) * 1000, minutes: 10080 });
      this.claude = { windows, updatedAt: (Number(data.savedAt) || 0) * 1000, source: 'Claude Code status line' };
    }
    if (emit) this.emit('update', this.snapshot());
  }

  claudeView() {
    const connected = this.claudeConnected();
    const base = { provider: 'claude', name: 'CLAUDE', available: !!this.claudeBin || connected, connected, url: USAGE_URLS.claude };
    if (!this.claude) return { ...base, windows: [], state: this.claudeBin ? (this.claudeFails >= 2 ? 'stale' : 'waiting') : connected ? 'waiting' : 'missing' };
    const now = Date.now();
    const windows = this.claude.windows.map((w) => (w.resetsAt && w.resetsAt < now ? { ...w, reset: true } : w));
    const stale = now - this.claude.updatedAt > CLAUDE_STALE_MS || this.claudeFails >= 2;
    return { ...base, windows, updatedAt: this.claude.updatedAt, source: this.claude.source, state: stale ? 'stale' : 'ok' };
  }

  claudePlan() {
    const s = readJson(CLAUDE_SETTINGS) || {};
    const before = s.statusLine?.command || null;
    return { settingsPath: CLAUDE_SETTINGS, before, after: `"${this.wrapperPath}"`, chained: !!before && !before.includes(this.wrapperPath) };
  }

  connectClaude() {
    const s = readJson(CLAUDE_SETTINGS) || {};
    if (s.statusLine?.command?.includes(this.wrapperPath)) return { ok: true, already: true };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.backupPath, JSON.stringify({ statusLine: s.statusLine ?? null, savedAt: Date.now() }, null, 2));
    if (s.statusLine?.command) fs.writeFileSync(this.originalCmdPath, s.statusLine.command);
    else fs.rmSync(this.originalCmdPath, { force: true });
    const script = [
      '#!/bin/sh',
      '# Ploink: saves Claude Code plan usage (only the rate_limits object) for the usage gauge,',
      '# then runs your original status line command so it keeps working. Remove it from',
      '# Ploink > Settings > AI usage > Disconnect.',
      `DIR=${shq(this.dir)}`,
      'input=$(cat)',
      'rl=$(printf \'%s\' "$input" | /usr/bin/plutil -extract rate_limits json -o - - 2>/dev/null)',
      'if [ -n "$rl" ]; then',
      '  printf \'{"savedAt":%s,"rate_limits":%s}\\n\' "$(date +%s)" "$rl" > "$DIR/claude-usage.json.tmp" && mv "$DIR/claude-usage.json.tmp" "$DIR/claude-usage.json"',
      'fi',
      'if [ -s "$DIR/claude-statusline-original.txt" ]; then',
      '  printf \'%s\' "$input" | sh -c "$(cat "$DIR/claude-statusline-original.txt")"',
      'elif [ -n "$rl" ]; then',
      '  # no status line of your own: show a small one with the same numbers',
      '  f=$(printf \'%s\' "$rl" | /usr/bin/plutil -extract five_hour.used_percentage raw -o - - 2>/dev/null)',
      '  w=$(printf \'%s\' "$rl" | /usr/bin/plutil -extract seven_day.used_percentage raw -o - - 2>/dev/null)',
      '  line="ploink"',
      '  [ -n "$f" ] && line="$line · 5h ${f%.*}%"',
      '  [ -n "$w" ] && line="$line · week ${w%.*}%"',
      '  printf \'%s\' "$line"',
      'fi',
      '',
    ].join('\n');
    fs.writeFileSync(this.wrapperPath, script, { mode: 0o755 });
    fs.chmodSync(this.wrapperPath, 0o755);
    s.statusLine = { ...(s.statusLine || {}), type: 'command', command: `"${this.wrapperPath}"` };
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
    const tmp = CLAUDE_SETTINGS + '.ploink.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
    fs.renameSync(tmp, CLAUDE_SETTINGS);
    this.emit('update', this.snapshot());
    return { ok: true };
  }

  disconnectClaude() {
    const s = readJson(CLAUDE_SETTINGS) || {};
    const backup = readJson(this.backupPath);
    if (s.statusLine?.command?.includes(this.wrapperPath)) {
      if (backup?.statusLine) s.statusLine = backup.statusLine;
      else delete s.statusLine;
      const tmp = CLAUDE_SETTINGS + '.ploink.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
      fs.renameSync(tmp, CLAUDE_SETTINGS);
    }
    fs.rmSync(this.originalCmdPath, { force: true });
    this.emit('update', this.snapshot());
    return { ok: true };
  }

  // ---------- Codex ----------
  codexView() {
    const base = { provider: 'codex', name: 'CODEX', available: !!this.codexBin, connected: !!this.codexBin, url: USAGE_URLS.codex };
    if (!this.codex) return { ...base, windows: [], state: this.codexBin ? 'waiting' : 'missing' };
    const now = Date.now();
    const windows = this.codex.windows.map((w) => (w.resetsAt && w.resetsAt < now ? { ...w, reset: true } : w));
    return { ...base, ...this.codex, windows, state: this.codexFails >= 2 ? 'stale' : 'ok' };
  }

  parseCodexLimits(rl, source) {
    if (!rl) return null;
    const windows = [];
    for (const key of ['primary', 'secondary']) {
      const w = rl[key];
      if (!w) continue;
      const mins = Number(w.windowDurationMins ?? w.window_minutes) || 0;
      const used = Number(w.usedPercent ?? w.used_percent);
      const resets = Number(w.resetsAt ?? w.resets_at) || 0;
      if (!Number.isFinite(used)) continue;
      windows.push({ label: windowLabel(mins), used, resetsAt: resets * 1000, minutes: mins });
    }
    if (!windows.length) return null;
    return {
      windows,
      reached: !!(rl.rateLimitReachedType || rl.rate_limit_reached_type),
      plan: rl.planType || rl.plan_type || null,
      updatedAt: Date.now(),
      source,
    };
  }

  pollCodex() {
    if (!this.codexBin) return Promise.resolve();
    if (this._codexBusy) return this._codexBusy;
    this._codexBusy = this.readCodexAppServer()
      .catch(() => this.readCodexSessions())
      .then((data) => {
        if (data) { this.codex = data; this.codexFails = 0; } else this.codexFails++;
      })
      .catch(() => { this.codexFails++; })
      .finally(() => { this._codexBusy = null; this.emit('update', this.snapshot()); });
    return this._codexBusy;
  }

  async readCodexAppServer() {
    const env = await loadShellEnv();
    return new Promise((resolve, reject) => {
      const child = spawn(this.codexBin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child.kill(); } catch { /* gone */ }
        if (err) reject(err); else resolve(val);
      };
      const timer = setTimeout(() => finish(new Error('codex app-server timed out')), 12_000);
      const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
      child.on('error', (e) => finish(e));
      child.on('exit', () => finish(new Error('codex app-server exited')));
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === 1) {
            if (msg.error) return finish(new Error(msg.error.message));
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/rateLimits/read' });
          } else if (msg.id === 2) {
            if (msg.error) return finish(new Error(msg.error.message));
            const data = this.parseCodexLimits(msg.result?.rateLimits, 'codex app-server');
            return data ? finish(null, data) : finish(new Error('no rate limits in reply'));
          }
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ploink', version: '0.2.1' } } });
    });
  }

  readCodexSessions() {
    // newest rollout file under ~/.codex/sessions/YYYY/MM/DD
    const newestChild = (dir) => {
      try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort().pop(); } catch { return null; }
    };
    let dir = CODEX_SESSIONS;
    for (let depth = 0; depth < 3; depth++) {
      const next = newestChild(dir);
      if (!next) return null;
      dir = path.join(dir, next);
    }
    const files = (() => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n)); } catch { return []; } })();
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files.slice(0, 3)) {
      const text = fs.readFileSync(file, 'utf8').slice(-400_000);
      const lines = text.split('\n').reverse();
      for (const line of lines) {
        if (!line.includes('rate_limits')) continue;
        try {
          const ev = JSON.parse(line);
          const rl = ev.payload?.rate_limits || ev.rate_limits || ev.payload?.info?.rate_limits;
          const data = this.parseCodexLimits(rl, 'Codex session log');
          if (data) return { ...data, updatedAt: fs.statSync(file).mtimeMs };
        } catch { /* partial line */ }
      }
    }
    return null;
  }
}
