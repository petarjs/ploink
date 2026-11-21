import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../main/store.mjs';
import { Runner } from '../main/runner.mjs';
import { resolveProject } from '../main/mcp.mjs';
import { detectProject } from '../main/detect.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploink-test-'));
const proj = path.join(tmp, 'site');
fs.mkdirSync(path.join(proj, 'public'), { recursive: true });
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'my-site', homepage: 'https://my.site', scripts: { deploy: 'x', 'deploy:staging': 'y', build: 'z' } }));
fs.writeFileSync(path.join(proj, 'pnpm-lock.yaml'), '');
fs.writeFileSync(path.join(proj, 'public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

function setup(cmd, extra = {}) {
  const store = new Store(fs.mkdtempSync(path.join(tmp, 'data-')));
  const project = store.upsertProject({ name: 'Site', cwd: proj, commands: [{ label: 'prod', cmd }], ...extra });
  return { store, runner: new Runner(store), project };
}

test('detects name, scripts, package manager, url and icon', () => {
  const d = detectProject(proj);
  assert.equal(d.name, 'My Site');
  assert.deepEqual(d.commands.map((c) => c.cmd), ['pnpm run deploy', 'pnpm run deploy:staging']);
  assert.equal(d.commands[1].label, 'staging');
  assert.equal(d.url, 'https://my.site');
  assert.match(d.icon, /^data:image\/svg\+xml;base64,/);
});

test('successful deploy streams output and ends in success', async () => {
  const { runner, project, store } = setup('echo hello && echo oops >&2');
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'success');
  assert.equal(done.exitCode, 0);
  assert.ok(done.log.includes('hello') && done.log.includes('oops'));
  assert.equal(store.historyFor(project.id)[0].status, 'success');
});

test('non-zero exit is a failure', async () => {
  const { runner, project } = setup('exit 7');
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'failed');
  assert.equal(done.exitCode, 7);
});

test('second request while busy is rejected', async () => {
  const { runner, project } = setup('sleep 2');
  const first = runner.request({ project });
  const second = runner.request({ project });
  assert.match(second.error, /already/);
  runner.cancel(first.run.id);
  const done = await runner.waitFor(first.run.id, 8000);
  assert.equal(done.status, 'cancelled');
});

test('agent deploys wait for approval when the project asks for it', async () => {
  const { runner, project } = setup('echo approved', { requireApproval: true });
  const { run } = runner.request({ project, source: 'agent', reason: 'test' });
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(runner.approve(run.id), true);
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'success');
});

test('denied agent request never runs', () => {
  const { runner, project, store } = setup('touch should-not-exist', { requireApproval: true });
  const { run } = runner.request({ project, source: 'agent' });
  assert.equal(runner.deny(run.id), true);
  assert.equal(runner.getRun(run.id).status, 'denied');
  assert.equal(fs.existsSync(path.join(proj, 'should-not-exist')), false);
  assert.equal(store.historyFor(project.id)[0].status, 'denied');
});

test('user deploys skip approval even when agents need it', () => {
  const { runner, project } = setup('true', { requireApproval: true });
  const { run } = runner.request({ project, source: 'user' });
  assert.notEqual(run.status, 'awaiting_approval');
  runner.cancel(run.id);
});

test('projects resolve by name, id, or a path inside the folder', () => {
  const { store, project } = setup('true');
  assert.equal(resolveProject(store, 'site')?.id, project.id);
  assert.equal(resolveProject(store, project.id)?.id, project.id);
  assert.equal(resolveProject(store, path.join(proj, 'public'))?.id, project.id);
  assert.equal(resolveProject(store, '/somewhere/else'), null);
});
