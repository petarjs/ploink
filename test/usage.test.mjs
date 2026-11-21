import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// never touch the real ~/.claude/settings.json
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploink usage '));
const settingsFile = path.join(tmp, 'claude', 'settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo ORIGINAL-STATUS', padding: 1 } }));
process.env.PLOINK_CLAUDE_SETTINGS = settingsFile;
const { Usage, parseClaudeUsage, parseResetText } = await import('../main/usage.mjs');

const dataDir = path.join(tmp, 'Ploink data');
fs.mkdirSync(dataDir);
const usage = new Usage({ dir: dataDir });

const sample = JSON.stringify({ session_id: 'secret-session', cwd: '/private/path', rate_limits: { five_hour: { used_percentage: 18.5, resets_at: 4102444800 }, seven_day: { used_percentage: 62, resets_at: 4102444800 } } });

test('connecting Claude wraps the existing status line and keeps other settings', () => {
  assert.equal(usage.claudeConnected(), false);
  usage.connectClaude();
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.equal(s.statusLine.padding, 1);
  assert.ok(s.statusLine.command.includes(usage.wrapperPath));
  assert.equal(usage.claudeConnected(), true);
});

test('the wrapper saves only rate_limits and still prints the original status line', () => {
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const run = spawnSync('/bin/sh', ['-c', s.statusLine.command], { input: sample, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ORIGINAL-STATUS/);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-usage.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['rate_limits', 'savedAt']);
  assert.ok(!JSON.stringify(saved).includes('secret-session'));
  usage.readClaude(false);
  const view = usage.claudeView();
  assert.equal(view.state, 'ok');
  assert.deepEqual(view.windows.map((w) => [w.label, w.used]), [['5H', 18.5], ['WK', 62]]);
});

test('disconnecting restores the original status line exactly', () => {
  usage.disconnectClaude();
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(s.statusLine, { type: 'command', command: 'echo ORIGINAL-STATUS', padding: 1 });
  assert.equal(usage.claudeConnected(), false);
});

test('with no status line of their own, people get a small Ploink one', () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }));
  const fresh = new Usage({ dir: dataDir });
  fresh.connectClaude();
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const run = spawnSync('/bin/sh', ['-c', s.statusLine.command], { input: sample, encoding: 'utf8' });
  assert.equal(run.stdout, 'ploink · 5h 18% · week 62%');
  fresh.disconnectClaude();
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).statusLine, undefined);
});

test('codex rate limits are named by window length, not by position', () => {
  const data = usage.parseCodexLimits({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1795262425 }, secondary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1795849225 }, rateLimitReachedType: 'rate_limit_reached' }, 'test');
  assert.deepEqual(data.windows.map((w) => [w.label, w.used]), [['5H', 100], ['WK', 16]]);
  assert.equal(data.reached, true);
  const logStyle = usage.parseCodexLimits({ primary: { used_percent: 40, window_minutes: 10080, resets_at: 1 } }, 'log');
  assert.equal(logStyle.windows[0].label, 'WK');
});

test('claude /usage output is parsed into windows', () => {
  const now = new Date(2026, 10, 21, 13, 0);
  const out = [
    'Warning: this sign-in ends between 2026-11-24 and 2026-11-27.',
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 23% used · resets 3pm (Europe/Belgrade)',
    'Current week (all models): 5% used · resets Nov 28 at 9am (Europe/Belgrade)',
    'Current week (Fable): 2% used · resets Nov 28 at 8:59am (Europe/Belgrade)',
    '',
    "What's contributing to your usage?",
  ].join('\n');
  const w = parseClaudeUsage(out, now);
  assert.deepEqual(w.map((x) => [x.label, x.used, x.extra]), [['5H', 23, false], ['WK', 5, false], ['FABLE', 2, true]]);
  const wk = new Date(w[1].resetsAt);
  assert.deepEqual([wk.getMonth(), wk.getDate(), wk.getHours(), wk.getMinutes()], [10, 28, 9, 0]);
  const s = new Date(w[0].resetsAt);
  assert.deepEqual([s.getDate(), s.getHours()], [21, 15]);
  assert.equal(new Date(parseResetText('11am (UTC)', now)).getDate(), 22); // already past today -> tomorrow
  assert.deepEqual(parseClaudeUsage('Not logged in'), []);
});
