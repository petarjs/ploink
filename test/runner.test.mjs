import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../main/store.mjs';
import { Runner } from '../main/runner.mjs';
import { resolveProject } from '../main/mcp.mjs';
import { detectProject } from '../main/detect.mjs';
import { commandSteps, commandScript, commandDisplay, commandSummary, looksLikeDryRun, printedDryRun } from '../renderer/steps.js';

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

test('command steps: blank lines, comments and continuations', () => {
  assert.deepEqual(commandSteps('git pull\n\nnpm ci\n# build first\nnpm run build \\\n  --prod\nnpm run deploy'), ['git pull', 'npm ci', 'npm run build   --prod', 'npm run deploy']);
  assert.deepEqual(commandSteps('a\r\nb'), ['a', 'b'], 'Windows line endings');
  assert.deepEqual(commandSteps('# a note \\\necho hi'), ['echo hi'], 'a comment never continues');
  assert.deepEqual(commandSteps('echo a\\\\\necho b'), ['echo a\\\\', 'echo b'], 'an escaped backslash is not a continuation');
  assert.deepEqual(commandSteps('echo end \\'), ['echo end'], 'a backslash on the last line');
  assert.deepEqual(commandSteps('   \n\n'), []);
});

test('a one-step command runs exactly as typed, && and all', () => {
  const one = 'git pull && npm ci && npm run deploy';
  assert.equal(commandScript(one), one);
  assert.equal(commandDisplay(one), one);
  assert.equal(commandSummary(one), one);
  assert.equal(commandScript('  npm run deploy  '), 'npm run deploy');
  assert.equal(commandScript('# deploy to prod\nnpm run deploy'), 'npm run deploy', 'comments around a single step');
});

test('several steps are grouped and joined with &&, and shown as one line or "first +N"', () => {
  const text = 'npm test # quick\nnpm run deploy';
  assert.equal(commandScript(text), '{ npm test # quick\n} && { npm run deploy\n}');
  assert.equal(commandDisplay(text), 'npm test # quick && npm run deploy');
  assert.equal(commandSummary(text), 'npm test # quick +1');
});

test('a multi-step deploy stops at the first failing step', async () => {
  const marker = path.join(tmp, 'third-step-ran');
  const { runner, project } = setup(`echo first\n# a comment\nexit 3\necho third > "${marker}"`);
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'failed');
  assert.equal(done.exitCode, 3);
  assert.ok(done.log.includes('first'));
  assert.equal(fs.existsSync(marker), false, 'the step after the failure never ran');
  assert.equal(done.cmd, `echo first && exit 3 && echo third > "${marker}"`, 'logs and agents see the joined command');
});

test('a multi-step deploy with a trailing comment and a continuation runs every step', async () => {
  const { runner, project } = setup('echo one # says one\necho two \\\n  and more\n\necho three');
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'success');
  for (const line of ['one', 'two and more', 'three']) assert.ok(done.log.includes(line), line);
});

test('agents see the joined command in list_projects', async () => {
  const { store } = setup('git pull\nnpm run deploy');
  store.updateSettings({ mcpAuth: 'off' });
  const { createMcp } = await import('../main/mcp.mjs');
  const mcp = createMcp({ store, runner: new Runner(store), getUsage: () => ({}), onAddProject: () => {}, onAgentActivity: () => {}, onUnauthorized: () => {} });
  const port = 47600 + Math.floor(Math.random() * 300);
  const state = await mcp.start(port);
  assert.equal(state.running, true, state.error);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }),
    });
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    const projects = Array.isArray(data) ? data : data.projects;
    const cmd = projects.flatMap((p) => p.commands).find((c) => c.steps);
    assert.equal(cmd.command, 'git pull && npm run deploy');
    assert.deepEqual(cmd.steps, ['git pull', 'npm run deploy']);
  } finally {
    mcp.stop();
  }
});

test('a dry-run command ends as a dry run, not a plain success, and names the real deploy', async () => {
  const store = new Store(fs.mkdtempSync(path.join(tmp, 'data-')));
  const project = store.upsertProject({
    name: 'Site', cwd: proj,
    commands: [{ label: 'deploy', cmd: 'echo deploying' }, { label: 'dry run', cmd: 'echo checking' }],
  });
  store.upsertProject({ id: project.id, activeCommandId: project.commands[1].id });
  const runner = new Runner(store);
  const { run } = runner.request({ project: store.projects.find((p) => p.id === project.id) });
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'success');
  assert.equal(done.dryRun, true);
  assert.equal(runner.summary(done).dryRun, true);
  assert.ok(done.log.some((l) => /nothing was deployed/.test(l) && /"deploy"/.test(l)));
  assert.equal(store.historyFor(project.id)[0].dryRun, true);
});

test('a deploy whose output says it was a dry run is marked as one', async () => {
  const { runner, project } = setup('echo "Total Upload: 1 KiB" && echo "--dry-run: exiting now."');
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'success');
  assert.equal(done.dryRun, true);
});

test('a dry run skips the site check after deploy', async () => {
  const { runner, project } = setup('echo would upload 3 files --dry-run', {
    actions: [{ label: 'site', kind: 'check', cmd: 'exit 1', afterDeploy: true }],
  });
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'success');
  assert.equal(done.dryRun, true);
  assert.equal(done.verify, null);
});

test('a normal deploy is not a dry run', async () => {
  const { runner, project } = setup('echo "Deployed to https://my.site"');
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'success');
  assert.equal(done.dryRun, false);
});

test('dry-run detection reads labels, commands and output', () => {
  assert.equal(looksLikeDryRun('pnpm run deploy:dry-run'), true);
  assert.equal(looksLikeDryRun('wrangler deploy --dry-run'), true);
  assert.equal(looksLikeDryRun('npm publish --dryrun'), true);
  assert.equal(looksLikeDryRun('npm run check', 'dry run'), true);
  assert.equal(looksLikeDryRun('npm run deploy', 'deploy'), false);
  assert.equal(looksLikeDryRun('npm run deploy', 'prod'), false);
  assert.equal(printedDryRun(['\x1b[2m--dry-run: exiting now.\x1b[0m']), true);
  assert.equal(printedDryRun(['Dry run complete. 3 files would be uploaded.']), true);
  assert.equal(printedDryRun(['Deployed to https://my.site', 'Skipping the dry run step']), false);
});
