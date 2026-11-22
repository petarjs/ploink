import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitHead, gitLabel, createGitWatch } from '../main/git.mjs';
import { deployTarget } from '../renderer/steps.js';
import { Store } from '../main/store.mjs';
import { Runner } from '../main/runner.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploink-target-'));

function repo(name, head) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
  return dir;
}

test('reads the branch from .git/HEAD, also from a subfolder', () => {
  const dir = repo('plain', 'ref: refs/heads/feat/dark-mode\n');
  assert.deepEqual(gitHead(dir), { branch: 'feat/dark-mode' });
  const sub = path.join(dir, 'apps', 'web');
  fs.mkdirSync(sub, { recursive: true });
  assert.deepEqual(gitHead(sub), { branch: 'feat/dark-mode' });
  assert.equal(gitLabel(gitHead(sub)), 'feat/dark-mode');
});

test('follows a .git file in worktrees and submodules', () => {
  const real = path.join(tmp, 'main-repo', '.git', 'worktrees', 'wt');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'HEAD'), 'ref: refs/heads/claude/fix\n');
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.relative(wt, real)}\n`);
  assert.deepEqual(gitHead(wt), { branch: 'claude/fix' });
});

test('a detached HEAD gives the short sha, a plain folder gives null', () => {
  const dir = repo('detached', '3f9c2ab8d1e04c7a9b6f5e4d3c2b1a0f9e8d7c6b\n');
  assert.deepEqual(gitHead(dir), { branch: null, detached: true, sha: '3f9c2ab' });
  assert.equal(gitLabel(gitHead(dir)), 'detached at 3f9c2ab');
  const plain = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(gitHead(plain), null);
  assert.equal(gitHead(''), null);
});

test('the git watch reports a branch switch once', () => {
  const dir = repo('watched', 'ref: refs/heads/main\n');
  const seen = [];
  const watch = createGitWatch({ projects: () => [{ id: 'p1', cwd: dir }], onChange: (s) => seen.push(s.p1?.branch) });
  watch.refresh();
  watch.refresh();
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/staging\n');
  watch.refresh();
  assert.deepEqual(seen, ['main', 'staging']);
});

test('target environment: explicit flags', () => {
  assert.equal(deployTarget('wrangler deploy --env staging')?.env, 'staging');
  assert.equal(deployTarget('serverless deploy --stage prod')?.env, 'production');
  assert.equal(deployTarget('pnpm exec cf deploy --prebuilt --mode production')?.env, 'production');
  assert.equal(deployTarget('vercel deploy --target=preview')?.env, 'preview');
  assert.equal(deployTarget('netlify deploy --prod')?.env, 'production');
  assert.equal(deployTarget('fly deploy --env qa')?.short, 'QA');
  assert.equal(deployTarget('wrangler deploy --env production').short, 'PROD');
});

test('target environment: platform defaults, script names and labels', () => {
  assert.equal(deployTarget('vercel deploy --prebuilt')?.env, 'preview', 'vercel without --prod is a preview');
  assert.equal(deployTarget('netlify deploy')?.env, 'preview');
  assert.equal(deployTarget('pnpm run deploy:staging')?.env, 'staging');
  assert.equal(deployTarget('make deploy-production')?.env, 'production');
  assert.deepEqual(deployTarget('npm run deploy', 'prod'), { env: 'production', short: 'PROD', from: 'label' });
  assert.equal(deployTarget('vercel deploy', 'production')?.env, 'preview', 'what runs beats the label');
});

test('target environment: no guessing', () => {
  assert.equal(deployTarget('wrangler deploy'), null);
  assert.equal(deployTarget('npm run deploy', 'deploy'), null);
  assert.equal(deployTarget('npm ci --production && npm run deploy'), null, 'install flags are not targets');
  assert.equal(deployTarget('wrangler deploy --env-file .env.production'), null);
  assert.equal(deployTarget('npm run build # prod later\nwrangler deploy'), null, 'comments are ignored');
});

test('a deploy records the branch and target, and says them in the log', async () => {
  const dir = repo('shipping', 'ref: refs/heads/release\n');
  const store = new Store(fs.mkdtempSync(path.join(tmp, 'data-')));
  const project = store.upsertProject({ name: 'Ship', cwd: dir, commands: [{ label: 'staging', cmd: 'echo shipping' }] });
  const runner = new Runner(store);
  const { run } = runner.request({ project });
  const done = await runner.waitFor(run.id, 10000);
  assert.equal(done.status, 'success');
  assert.equal(done.branch, 'release');
  assert.equal(done.target, 'staging');
  assert.ok(done.log.some((l) => l.includes('on release to staging')));
  assert.equal(store.historyFor(project.id)[0].branch, 'release');
});
