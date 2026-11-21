import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../main/store.mjs';
import { Runner, checkValue } from '../main/runner.mjs';
import { createMcp } from '../main/mcp.mjs';
import { detectProject } from '../main/detect.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploink-actions-'));
const proj = path.join(tmp, 'app');
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'app', homepage: 'https://app.example', scripts: { deploy: 'x', dev: 'vite' } }));

function setup({ commands = [{ label: 'prod', cmd: 'echo deployed' }], actions = [], ...extra } = {}) {
  const store = new Store(fs.mkdtempSync(path.join(tmp, 'data-')));
  const project = store.upsertProject({ name: 'App', cwd: proj, url: 'https://app.example', commands, actions, ...extra });
  return { store, runner: new Runner(store, { verifyGapMs: 20 }), project };
}
const byLabel = (project, label) => project.actions.find((a) => a.label === label);

test('a check shows the last line, or a regex capture, with short decimals', () => {
  assert.equal(checkValue(['noise', '200 · 0.213456s', ''], ''), '200 · 0.21s');
  assert.equal(checkValue(['expires in 34 days, ok'], '(\\d+) days'), '34');
  assert.equal(checkValue(['\x1b[32mgreen\x1b[0m'], '('), 'green'); // bad regex falls back
});

test('a check runs while a deploy is busy, and reports its value', async () => {
  const { runner, project } = setup({ commands: [{ label: 'prod', cmd: 'sleep 1' }], actions: [{ label: 'health', kind: 'check', cmd: 'echo ok; echo "200 · 0.1234s"' }] });
  const deploy = runner.request({ project });
  const check = runner.request({ project, actionId: byLabel(project, 'health').id });
  assert.equal(check.error, undefined);
  const done = await runner.waitFor(check.run.id, 5000);
  assert.equal(done.status, 'success');
  assert.equal(done.value, '200 · 0.12s');
  assert.equal(done.kind, 'check');
  assert.equal(runner.latestRunFor(project.id).id, deploy.run.id, 'action runs never replace the latest deploy');
  runner.cancel(deploy.run.id);
});

test('a service shows its localhost URL and stops cleanly', async () => {
  const { runner, project } = setup({ actions: [{ label: 'dev', kind: 'service', cmd: 'echo "  Local: http://localhost:5173/"; sleep 30' }] });
  const { run } = runner.request({ project, actionId: byLabel(project, 'dev').id });
  for (let i = 0; i < 50 && !runner.getRun(run.id).url; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(runner.getRun(run.id).url, 'http://localhost:5173/');
  assert.equal(runner.request({ project, actionId: byLabel(project, 'dev').id }).error, 'dev is already running.');
  runner.cancel(run.id);
  const done = await runner.waitFor(run.id, 6000);
  assert.equal(done.status, 'stopped');
});

test('a deploy is shipped only after its site check passes', async () => {
  const { runner, project } = setup({ actions: [{ label: 'health', kind: 'check', cmd: 'echo "200 · 0.2s"', afterDeploy: true }] });
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 8000);
  assert.equal(done.status, 'success');
  assert.deepEqual(done.verify, { ok: true, label: 'health', value: '200 · 0.2s' });
});

test('a deploy whose site check keeps failing ends red', async () => {
  const { runner, project } = setup({ actions: [{ label: 'health', kind: 'check', cmd: 'echo "503 · 0.4s"; exit 22', afterDeploy: true }] });
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 8000);
  assert.equal(done.status, 'failed');
  assert.equal(done.verify.ok, false);
  assert.equal(done.verify.value, '503 · 0.4s');
  assert.ok(done.log.some((l) => l.includes('try 4 of 4')));
});

test('agents may press only the keys the user allowed', () => {
  const { runner, project } = setup({ actions: [{ label: 'pull', kind: 'oneshot', cmd: 'true', agents: false }] });
  const res = runner.request({ project, actionId: byLabel(project, 'pull').id, source: 'agent' });
  assert.match(res.error, /Agents may not press "pull"/);
});

test('hold-to-run keys always ask when an agent presses them', () => {
  const { runner, project } = setup({ actions: [{ label: 'reset', kind: 'oneshot', cmd: 'true', agents: true, hold: true }] });
  const { run } = runner.request({ project, actionId: byLabel(project, 'reset').id, source: 'agent' });
  assert.equal(run.status, 'awaiting_approval');
  runner.deny(run.id);
});

test('a command an agent added needs approval once, and the user must review it first', async () => {
  const { runner, project, store } = setup({ commands: [{ label: 'prod', cmd: 'echo hi', trusted: false }] });
  assert.equal(store.settings.agentApproval, 'auto');
  const mine = runner.request({ project, source: 'user' });
  assert.equal(mine.review, true);
  let trusted = null;
  runner.on('trusted', (r) => { trusted = r; });
  const { run } = runner.request({ project, source: 'agent' });
  assert.equal(run.status, 'awaiting_approval', 'auto-deploy does not cover agent-added commands');
  runner.approve(run.id);
  assert.equal(trusted?.id, run.id);
  assert.equal((await runner.waitFor(run.id, 5000)).status, 'success');
});

test('checks keep 5 runs of history and never push deploys out', () => {
  const { store, project } = setup();
  for (let i = 0; i < 3; i++) store.addHistory({ id: `d${i}`, projectId: project.id, actionId: null, createdAt: i });
  for (let i = 0; i < 9; i++) store.addHistory({ id: `c${i}`, projectId: project.id, actionId: 'x_1', createdAt: 10 + i });
  assert.equal(store.history.filter((r) => r.actionId).length, 5);
  assert.equal(store.historyFor(project.id, 25, { deploysOnly: true }).length, 3);
});

test('detection suggests a health check and the dev server', () => {
  const d = detectProject(proj);
  assert.deepEqual(d.actions.map((a) => [a.label, a.kind]), [['health', 'check'], ['dev', 'service']]);
  assert.equal(d.actions[0].afterDeploy, true);
  assert.equal(d.actions[0].agents, true);
  assert.equal(d.actions[1].agents, false);
});

test('the MCP server wants a client token, and press returns a check value', async () => {
  const { store, runner, project } = setup({ actions: [{ label: 'health', kind: 'check', cmd: 'echo "200 · 0.1s"', agents: true }, { label: 'secret', kind: 'oneshot', cmd: 'true' }] });
  const client = store.addClient('Test agent');
  let unauthorized = 0;
  const mcp = createMcp({ store, runner, onAddProject: async () => project, onUnauthorized: () => unauthorized++ });
  const port = 47900 + Math.floor(Math.random() * 90);
  const st = await mcp.start(port);
  assert.equal(st.running, true);
  const call = (body, token) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  try {
    const anon = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(anon.status, 401);
    assert.match((await anon.json()).error.message, /token/);
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'plk_wrong_token_wrong_token')).status, 401);
    assert.equal(unauthorized, 2);

    const list = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }, client.token)).json();
    const projects = JSON.parse(list.result.content[0].text).projects;
    assert.deepEqual(projects[0].actions.map((a) => a.label), ['health'], 'keys agents may not press are hidden');

    const pressed = await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'press', arguments: { project: 'App', key: 'health', wait: true } } }, client.token)).json();
    const report = JSON.parse(pressed.result.content[0].text);
    assert.equal(report.status, 'success');
    assert.equal(report.value, '200 · 0.1s');
    assert.equal(report.started_by, 'agent (Test agent)');

    const hidden = await (await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'press', arguments: { project: 'App', key: 'secret' } } }, client.token)).json();
    assert.equal(hidden.result.isError, true);

    store.removeClient(client.id);
    assert.equal((await call({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, client.token)).status, 401, 'revoked tokens stop working at once');
  } finally {
    mcp.stop();
  }
});

test('the config file is readable only by you', () => {
  const { store } = setup();
  store.flush();
  const mode = fs.statSync(store.configFile).mode & 0o777;
  assert.equal(mode, 0o600);
});
