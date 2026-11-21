import { commandDisplay, looksLikeDryRun } from './steps.js';
// In-browser stand-in for the Electron bridge, so the UI can be previewed and
// designed without the app. Deploys are simulated. window.__mock drives agent events.
const svg = (body, bg = 'none') =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/>${body}</svg>`);

const ICONS = {
  forge: svg('<path d="M32 10 52 21v22L32 54 12 43V21z" fill="#ff7a1a"/><path d="M32 10 52 21 32 32 12 21z" fill="#ffb066"/><path d="M32 32v22l20-11V21z" fill="#d9570a"/>'),
  ink: svg('<path d="M48 12C30 14 18 28 16 50l6-6c4-1 10-3 14-8l-6-1 9-3c4-5 7-12 9-20z" fill="#2f7cf6"/><path d="M16 50 34 30" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>', '#e9f1ff'),
  tide: svg('<path d="M8 38c6 0 6-6 12-6s6 6 12 6 6-6 12-6 6 6 12 6v14H8z" fill="#0fb5a3"/><path d="M8 28c6 0 6-6 12-6s6 6 12 6 6-6 12-6 6 6 12 6" fill="none" stroke="#7de8dc" stroke-width="4" stroke-linecap="round"/>'),
  donut: svg('<circle cx="32" cy="32" r="20" fill="#f6c27a"/><circle cx="32" cy="32" r="16" fill="#e64aa0"/><circle cx="32" cy="32" r="6" fill="#fff"/><g stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M24 22l3 2M40 21l-2 3M44 34l-3 1M22 38l3-1M33 45l1-3"/></g>'),
  leaf: svg('<path d="M14 50C14 26 30 14 52 12c0 24-12 38-36 38z" fill="#2fb36e"/><path d="M16 48 40 24" stroke="#c9f5da" stroke-width="3" stroke-linecap="round"/>'),
};

const now = Date.now();
const HEALTH = `curl -fsSL -o /dev/null --max-time 15 -w '%{http_code} · %{time_total}s' "$PLOINK_URL"`;
const projects = [
  { id: 'p1', name: 'Pixel Forge', cwd: '/Users/you/code/pixel-forge', url: 'https://pixelforge.example', icon: ICONS.forge, color: '#f76b15', commands: [{ id: 'c1', label: 'prod', cmd: 'git pull --ff-only\nnpm ci\n# build, then ship what is on disk\nnpm run build\nnpm run deploy -- --prod \\\n  --message "from Ploink"' }, { id: 'c2', label: 'preview', cmd: 'npm run deploy:preview' }], activeCommandId: 'c1', actions: [{ id: 'x1', label: 'health', kind: 'check', cmd: HEALTH, agents: true, afterDeploy: true }, { id: 'x2', label: 'dev', kind: 'service', cmd: 'npm run dev' }, { id: 'x3', label: 'pull', kind: 'oneshot', cmd: 'git pull --ff-only', agents: true }] },
  { id: 'p2', name: 'Inkwell Blog', cwd: '/Users/you/code/inkwell', url: 'https://inkwell.example', icon: ICONS.ink, color: '#1e93f0', commands: [{ id: 'c3', label: 'deploy', cmd: 'pnpm run deploy' }], activeCommandId: 'c3', actions: [{ id: 'x4', label: 'test', kind: 'oneshot', cmd: 'pnpm test', agents: true }, { id: 'x5', label: 'ssl days', kind: 'check', cmd: 'echo "34 days"' }] },
  { id: 'p3', name: 'Tidepool API', cwd: '/Users/you/code/tidepool', url: 'https://api.tidepool.example', icon: ICONS.tide, color: '#13a596', commands: [{ id: 'c4', label: 'fly', cmd: 'fly deploy' }], activeCommandId: 'c4', actions: [{ id: 'x6', label: 'health', kind: 'check', cmd: HEALTH, agents: true }, { id: 'x7', label: 'migrate', kind: 'oneshot', cmd: 'fly ssh console -C "npm run migrate"', hold: true }] },
  { id: 'p4', name: 'Bakery Orders', cwd: '/Users/you/code/bakery', url: 'https://orders.bakery.example', icon: ICONS.donut, color: '#d6409f', commands: [{ id: 'c5', label: 'prod', cmd: 'vercel deploy --prod' }, { id: 'c6', label: 'preview', cmd: 'vercel deploy' }], activeCommandId: 'c5', requireApproval: true, actions: [{ id: 'x8', label: 'seed', kind: 'oneshot', cmd: 'npm run db:seed', trusted: false, agents: true }] },
  { id: 'p5', name: 'Northwind Docs', cwd: '/Users/you/code/northwind-docs', url: 'https://docs.northwind.example', icon: ICONS.leaf, color: '#2fa86a', commands: [{ id: 'c7', label: 'deploy', cmd: 'npx wrangler deploy' }], activeCommandId: 'c7' },
  { id: 'p6', name: 'Atlas CLI', cwd: '/Users/you/code/atlas', url: '', icon: null, color: '#e9e4d4', commands: [{ id: 'c8', label: 'publish', cmd: 'npm publish' }], activeCommandId: 'c8' },
];

let settings = { shortcut: 'F5', holdMs: 650, sound: true, volume: 0.7, mcpEnabled: true, mcpPort: 47321, mcpAuth: 'token', mcpClients: [{ id: 'k1', name: 'Claude Code', token: 'plk_demo_7Qm2v9XcL0aR4tYw8nBz', createdAt: now - 86400e3, lastUsedAt: now - 9 * 60e3 }], agentApproval: 'auto', systemNotifications: false, announce: true, shortcutOpens: 'bar', bar: { enabled: true, edge: 'bottom', visibility: 'shortcut', size: 'medium', style: 'mini' }, buttonShape: 'round', iconScale: 0.5, barLabels: true, usage: { claude: true, codex: true }, hideOnBlur: false, launchAtLogin: false, deployTimeoutMin: 30 };
const runs = new Map();
const listeners = new Set();
const emit = (type, payload) => listeners.forEach((fn) => fn({ type, ...payload }));
let rid = 0;

function mkRun(project, cmd, status, extra = {}) {
  return { id: 'r' + ++rid, projectId: project.id, projectName: project.name, commandId: cmd.id, commandLabel: cmd.label, cmd: commandDisplay(cmd.cmd), cwd: project.cwd, source: 'user', reason: '', status, createdAt: Date.now(), startedAt: null, endedAt: null, exitCode: null, log: [], ...extra };
}
// seed history
runs.set('h1', { ...mkRun(projects[0], projects[0].commands[0], 'success'), id: 'h1', createdAt: now - 3 * 3600e3, startedAt: now - 3 * 3600e3, endedAt: now - 3 * 3600e3 + 48e3, exitCode: 0, log: ['\x1b[2m$ npm run deploy\x1b[0m', '\x1b[32m✓\x1b[0m Deployed'] });
runs.set('h2', { ...mkRun(projects[2], projects[2].commands[0], 'failed'), id: 'h2', createdAt: now - 26 * 60e3, startedAt: now - 26 * 60e3, endedAt: now - 25 * 60e3, exitCode: 1, log: ['\x1b[2m$ fly deploy\x1b[0m', '\x1b[31mError:\x1b[0m health checks failed for machine 4d89'] });
runs.set('h3', { ...mkRun(projects[4], projects[4].commands[0], 'success'), id: 'h3', source: 'agent', createdAt: now - 5 * 60e3, startedAt: now - 5 * 60e3, endedAt: now - 4.3 * 60e3, exitCode: 0, log: ['\x1b[32m✓\x1b[0m Uploaded northwind-docs'] });

function mockUsage() {
  const t = Date.now() / 1000;
  return {
    claude: { provider: 'claude', name: 'CLAUDE', available: true, connected: true, state: 'ok', source: 'Claude Code status line', updatedAt: Date.now() - 4 * 60e3, url: '#', windows: [{ label: '5H', used: 18, resetsAt: (t + 3 * 3600) * 1000, minutes: 300 }, { label: 'WK', used: 62, resetsAt: (t + 4 * 86400) * 1000, minutes: 10080 }] },
    codex: { provider: 'codex', name: 'CODEX', available: true, connected: true, state: 'ok', source: 'codex app-server', updatedAt: Date.now(), reached: true, url: '#', windows: [{ label: '5H', used: 100, resetsAt: (t + 5400) * 1000, minutes: 300 }, { label: 'WK', used: 16, resetsAt: (t + 6 * 86400) * 1000, minutes: 10080 }] },
  };
}
const activity = [];
function logA(e) { const ev = { id: 'a' + Math.random().toString(36).slice(2, 8), at: Date.now(), ...e }; activity.unshift(ev); emit('activity', { event: ev }); }
const runBase = (r) => ({ projectId: r.projectId, projectName: r.projectName, runId: r.id, command: r.commandLabel, source: r.source, reason: r.reason || undefined, ...(r.dryRun ? { dryRun: true } : {}) });
for (const r of [runs.get('h1'), runs.get('h2'), runs.get('h3')]) {
  activity.push({ ...runBase(r), id: r.id + 's', at: r.startedAt, type: 'started' });
  activity.push({ ...runBase(r), id: r.id + 'e', at: r.endedAt, type: r.status === 'success' ? 'succeeded' : 'failed', exitCode: r.exitCode, durationMs: r.endedAt - r.startedAt, detail: r.status === 'failed' ? 'Error: health checks failed for machine 4d89' : undefined });
}
activity.push({ id: 'ax', at: now - 26 * 3600e3, type: 'added', projectId: 'p6', projectName: 'Atlas CLI', source: 'agent' });
activity.sort((a, b) => b.at - a.at);

const summary = (r) => { if (!r) return null; const { log, timer, ...rest } = r; return { ...rest, lastLine: (log[log.length - 1] || '').replace(/\x1b\[[0-9;]*m/g, '') }; };
const latest = (pid, aid = null) => [...runs.values()].filter((r) => r.projectId === pid && (r.actionId || null) === aid).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
const active = (pid, aid = null) => [...runs.values()].find((r) => r.projectId === pid && (r.actionId || null) === aid && ['running', 'starting', 'awaiting_approval'].includes(r.status));
// seed: a passing health check on Pixel Forge, a failing one on Tidepool
runs.set('k1', { ...mkRun(projects[0], projects[0].actions[0], 'success'), id: 'k1', actionId: 'x1', kind: 'check', value: '200 · 0.21s', createdAt: now - 6 * 60e3, startedAt: now - 6 * 60e3, endedAt: now - 6 * 60e3 + 400, exitCode: 0, log: ['200 · 0.21s'] });
runs.set('k2', { ...mkRun(projects[2], projects[2].actions[0], 'failed'), id: 'k2', actionId: 'x6', kind: 'check', value: '503 · 0.40s', createdAt: now - 20 * 60e3, startedAt: now - 20 * 60e3, endedAt: now - 20 * 60e3 + 500, exitCode: 22, log: ['503 · 0.40s'] });

function simulateAction(run, a, p) {
  run.status = 'running';
  run.startedAt = Date.now();
  run.log.push(`\x1b[2m$ ${run.cmd}\x1b[0m`, `\x1b[2m  in ${run.cwd}\x1b[0m`, '');
  emit('run', { run: summary(run) });
  const line = (l) => { run.log.push(l); emit('log', { runId: run.id, projectId: run.projectId, actionId: run.actionId, lines: [l], lastLine: l.replace(/\x1b\[[0-9;]*m/g, '') }); };
  const end = (status, code, value) => { run.status = status; run.exitCode = code; run.endedAt = Date.now(); if (value) run.value = value; emit('run', { run: summary(run) }); };
  if (a.kind === 'service') {
    run.timer = setTimeout(() => { line('  \x1b[1;36mVITE\x1b[0m v7.1.2  ready in 412 ms'); line('  ➜  Local:   \x1b[36mhttp://localhost:5173/\x1b[0m'); run.url = 'http://localhost:5173/'; emit('run', { run: summary(run) }); }, 900);
    return;
  }
  if (a.kind === 'check') {
    const down = p.id === 'p3';
    const value = a.label === 'ssl days' ? '34 days' : down ? '503 · 0.40s' : `200 · 0.${Math.floor(rand(12, 48))}s`;
    run.timer = setTimeout(() => { line(value); end(down ? 'failed' : 'success', down ? 22 : 0, value); }, 700);
    return;
  }
  const steps = a.label === 'pull' ? ['Updating 3f2a1c4..9b7e0d2', 'Fast-forward', ' src/checkout.ts | 12 ++++++------', ' 1 file changed, 6 insertions(+), 6 deletions(-)'] : ['\x1b[2m> vitest run\x1b[0m', ' \x1b[32m✓\x1b[0m src/cart.test.ts (14 tests)', ' \x1b[32m✓\x1b[0m src/price.test.ts (9 tests)', ' Test Files  2 passed (2)', '      Tests  23 passed (23)'];
  let i = 0;
  const next = () => { if (run.status !== 'running') return; if (i >= steps.length) return end('success', 0); line(steps[i++]); run.timer = setTimeout(next, 380); };
  run.timer = setTimeout(next, 300);
}
const rand = (a, b) => a + Math.random() * (b - a);

const SCRIPT = [
  ['\x1b[1m▲ Ploink\x1b[0m preparing build', 300],
  ['\x1b[2m> vite build\x1b[0m', 400],
  ['\x1b[36mvite v7.1.2\x1b[0m building for production...', 500],
  ['transforming (412) src/components/Checkout.tsx', 600],
  ['\x1b[32m✓\x1b[0m 1,284 modules transformed.', 500],
  ['dist/index.html                  \x1b[2m0.46 kB\x1b[0m', 150],
  ['dist/assets/index-4f2a1c.css    \x1b[2m38.12 kB\x1b[0m', 150],
  ['dist/assets/index-9b7e0d.js    \x1b[2m214.83 kB\x1b[0m', 300],
  ['\x1b[32m✓\x1b[0m built in 2.41s', 500],
  ['Uploading 37 files \x1b[2m(1.2 MB)\x1b[0m', 900],
  ['\x1b[33m⠋\x1b[0m Waiting for deployment to be ready', 900],
  ['\x1b[32m✓\x1b[0m Deployed to \x1b[4mhttps://example.app\x1b[0m', 200],
];

function simulate(run, fail) {
  run.status = 'running';
  run.startedAt = Date.now();
  logA({ ...runBase(run), type: 'started' });
  run.log.push(`\x1b[2m$ ${run.cmd}\x1b[0m`, `\x1b[2m  in ${run.cwd}\x1b[0m`, '');
  emit('run', { run: summary(run) });
  let i = 0;
  const steps = fail ? SCRIPT.slice(0, 5).concat([['\x1b[31m✗ Error:\x1b[0m Build failed: Cannot find module "./config.prod"', 300]]) : SCRIPT;
  const next = () => {
    if (run.status !== 'running') return;
    if (i >= steps.length && !fail && !run.verified && run.verifyAction && !run.dryRun) {
      // like the app: SHIPPED waits for the site check
      run.verified = true;
      run.phase = 'verify';
      for (const l of ['', '\x1b[2m── health check ──\x1b[0m', `\x1b[2m$ ${run.verifyAction.cmd}\x1b[0m`]) run.log.push(l);
      emit('run', { run: summary(run) });
      run.timer = setTimeout(() => { run.log.push('200 · 0.19s'); run.verify = { ok: true, label: 'health', value: '200 · 0.19s' }; run.phase = null; next(); }, 1100);
      return;
    }
    if (i >= steps.length) {
      run.status = fail ? 'failed' : 'success';
      run.exitCode = fail ? 1 : 0;
      run.endedAt = Date.now();
      logA({ ...runBase(run), type: fail ? 'failed' : 'succeeded', exitCode: run.exitCode, durationMs: run.endedAt - run.startedAt, detail: fail ? 'Build failed: Cannot find module "./config.prod"' : undefined });
      emit('run', { run: summary(run) });
      return;
    }
    const [line, wait] = steps[i++];
    run.log.push(line);
    emit('log', { runId: run.id, projectId: run.projectId, lines: [line], lastLine: line.replace(/\x1b\[[0-9;]*m/g, '') });
    run.timer = setTimeout(next, wait);
  };
  run.timer = setTimeout(next, 300);
}

let failNext = new Set(['p3']);

// ---- button packs + Pro (the preview server serves the real pack files at /__packs.json)
// ?pack=<id> picks a pack, ?pro=1 starts unlocked, ?founder=<n> sets the founder number.
const qs = new URLSearchParams(location.search);
const packData = await fetch('/__packs.json').then((r) => r.json()).catch(() => ({ packs: [], proBuild: false }));
if (qs.get('pack')) settings.pack = qs.get('pack');
let license = qs.get('pro') ? { pro: true, status: 'active', kind: 'founder', founder: Number(qs.get('founder')) || 1, keyHint: 'PQR2', email: 'f••••••@example.com', checkedAt: Date.now() - 2 * 3600e3 } : { pro: false, status: 'none' };
function lookState() {
  const packs = packData.packs.map((p) => ({ ...p, locked: p.tier === 'pro' && !license.pro }));
  const pack = packs.find((p) => p.id === settings.pack && !p.locked) || packs.find((p) => p.id === 'dev.ploink.mission-control') || null;
  return { pack, packs, license, proBuild: packData.proBuild, proVersion: packData.proVersion || '' };
}

export const mockBridge = {
  isMock: true,
  async getState() {
    const l = {};
    const acts = {};
    for (const p of projects) {
      l[p.id] = summary(latest(p.id));
      for (const a of p.actions || []) { const r = latest(p.id, a.id); if (r) (acts[p.id] ||= {})[a.id] = summary(r); }
    }
    return { projects: structuredClone(projects), settings: structuredClone(settings), latest: l, actions: acts, mcp: { running: true, port: 47321, url: 'http://127.0.0.1:47321/mcp' }, shortcut: { ok: true }, platform: 'darwin', appPath: '/Applications/Ploink.app/Contents/Resources/app', version: '0.2.0', look: lookState() };
  },
  async saveProject(input) {
    let p = projects.find((x) => x.id === input.id);
    if (p) Object.assign(p, input);
    else { p = { id: 'p' + Math.random().toString(36).slice(2, 7), commands: [], ...input }; projects.push(p); }
    p.commands = (p.commands || []).map((c, i) => ({ id: c.id || 'c' + Math.random().toString(36).slice(2, 7), ...c }));
    if (!p.commands.some((c) => c.id === p.activeCommandId)) p.activeCommandId = p.commands[0]?.id || null;
    emit('projects', { projects: structuredClone(projects) });
    return structuredClone(p);
  },
  async deleteProject(id) { const i = projects.findIndex((p) => p.id === id); if (i >= 0) projects.splice(i, 1); emit('projects', { projects: structuredClone(projects) }); return true; },
  async reorderProjects() { return true; },
  async detectProject(dir) { const name = dir.split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); return { cwd: dir, name, commands: [{ label: 'deploy', cmd: 'npm run deploy' }], actions: [{ label: 'dev', kind: 'service', cmd: 'npm run dev' }], url: '', icon: null, hints: ['package.json script "deploy"'] }; },
  async addProjectPath(dir) { const d = await this.detectProject(dir); const project = await this.saveProject(d); emit('project-added', { id: project.id }); return { project }; },
  async pickFolder() { return '/Users/you/code/new-shiny-thing'; },
  async pickIcon() { return null; },
  async fetchIcon() { return null; },
  async deploy({ projectId, commandId }, source = 'user', reason = '') {
    const p = projects.find((x) => x.id === projectId);
    if (active(projectId)) return { error: `${p.name} is already deploying.` };
    const cmd = p.commands.find((c) => c.id === commandId) || p.commands[0];
    const needs = source === 'agent' && (settings.agentApproval === 'ask' || p.requireApproval);
    const verifyAction = (p.actions || []).find((a) => a.kind === 'check' && a.afterDeploy) || null;
    const run = mkRun(p, cmd, needs ? 'awaiting_approval' : 'starting', { source, reason, kind: 'deploy', verifyAction, dryRun: looksLikeDryRun(cmd.cmd, cmd.label) });
    runs.set(run.id, run);
    emit('run', { run: summary(run) });
    if (!needs) simulate(run, failNext.delete(projectId));
    return { run: summary(run) };
  },
  async runAction({ projectId, actionId }, source = 'user', reason = '') {
    const p = projects.find((x) => x.id === projectId);
    const a = p?.actions?.find((x) => x.id === actionId);
    if (!a) return { error: 'That action key no longer exists.' };
    if (a.trusted === false && source !== 'agent') return { error: 'Review it first.', review: true };
    if (active(projectId, actionId)) return { error: `${a.label} is already running.` };
    const needs = source === 'agent' && (a.hold || a.trusted === false || settings.agentApproval === 'ask');
    const run = { ...mkRun(p, a, needs ? 'awaiting_approval' : 'starting', { source, reason }), actionId, kind: a.kind, client: source === 'agent' ? 'Claude Code' : '' };
    runs.set(run.id, run);
    emit('run', { run: summary(run) });
    if (!needs) simulateAction(run, a, p);
    return { run: summary(run) };
  },
  async trust({ projectId, commandId, actionId }) {
    const p = projects.find((x) => x.id === projectId);
    for (const b of [...(p?.commands || []), ...(p?.actions || [])]) if (b.id === commandId || b.id === actionId) b.trusted = true;
    emit('projects', { projects: structuredClone(projects) });
    return true;
  },
  async addMcpClient(name) { const c = { id: 'k' + Math.random().toString(36).slice(2, 7), name, token: 'plk_' + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14), createdAt: Date.now(), lastUsedAt: null }; settings.mcpClients = [...settings.mcpClients, c]; return c; },
  async removeMcpClient(id) { settings.mcpClients = settings.mcpClients.filter((c) => c.id !== id); return true; },
  async cancel(id) { const r = runs.get(id); if (!r) return false; clearTimeout(r.timer); if (r.kind === 'service') { r.status = 'stopped'; r.endedAt = Date.now(); r.log.push('', '\x1b[2mStopped.\x1b[0m'); emit('run', { run: summary(r) }); return true; } r.status = 'cancelled'; r.endedAt = Date.now(); r.log.push('', '\x1b[2mCancelled.\x1b[0m'); emit('run', { run: summary(r) }); return true; },
  async approve(id) {
    const r = runs.get(id);
    if (!r || r.status !== 'awaiting_approval') return false;
    r.status = 'starting';
    emit('run', { run: summary(r) });
    if (r.actionId) { const p = projects.find((x) => x.id === r.projectId); simulateAction(r, p.actions.find((a) => a.id === r.actionId), p); } else simulate(r, false);
    return true;
  },
  async deny(id) { const r = runs.get(id); if (!r) return false; r.status = 'denied'; r.endedAt = Date.now(); emit('run', { run: summary(r) }); return true; },
  async getRun(id) { const r = runs.get(id); return r ? { ...summary(r), log: [...r.log] } : null; },
  async getUsage() { return mockUsage(); },
  async refreshUsage() { return mockUsage(); },
  async openUsage() { return true; },
  async connectClaude() { return { ok: true }; },
  async disconnectClaude() { return { ok: true }; },
  async getActivity(limit = 400) { return activity.slice(0, limit); },
  async getHistory(pid) { return [...runs.values()].filter((r) => r.projectId === pid).sort((a, b) => b.createdAt - a.createdAt).map(summary); },
  async getLook() { return lookState(); },
  async activatePro(key) {
    await new Promise((r) => setTimeout(r, 700));
    if (!/^[A-Z0-9-]{16,}$/i.test(String(key).replace(/\s/g, ''))) return { error: 'That is not a license key or a founder code. License keys look like XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX. Founder codes have 16 letters and digits.', look: lookState() };
    license = { pro: true, status: 'active', kind: key.includes('-') && key.length > 30 ? 'gumroad' : 'founder', founder: 1, keyHint: String(key).slice(-4).toUpperCase(), email: 'f••••••@example.com', checkedAt: Date.now() };
    emit('look', { look: lookState() });
    return { ok: true, license, look: lookState() };
  },
  async deactivatePro() { license = { pro: false, status: 'none' }; emit('look', { look: lookState() }); return lookState(); },
  async refreshPro() { return lookState(); },
  async installPack() { return { error: 'Installing packs needs the app; the browser preview can only show the built-in ones.' }; },
  async removePack() { return { ok: false, look: lookState() }; },
  async saveSettings(patch) { settings = { ...settings, ...patch, bar: { ...settings.bar, ...(patch.bar || {}) } }; if (patch.pack !== undefined) setTimeout(() => emit('look', { look: lookState() })); return { settings, shortcut: { ok: true }, mcp: { running: settings.mcpEnabled, port: settings.mcpPort, url: `http://127.0.0.1:${settings.mcpPort}/mcp` } }; },
  async hide() {},
  async copy(t) { try { await navigator.clipboard.writeText(t); } catch { /* ignore */ } return true; },
  async reveal() { return true; },
  async openUrl(u) { window.open(u, '_blank'); return true; },
  async pauseShortcut() { return true; },
  pathForFile: (f) => '/Users/you/code/' + (f.name || 'dropped-folder'),
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

window.__mock = {
  announce(index, status) { const p = projects[index]; const r = latest(p.id); emit('bar:announce', { runId: r?.id, projectId: p.id, status: status || r?.status }); },
  press(index = 0, label = 'health', reason = 'checking after my fix') {
    const p = projects[index];
    const a = p.actions.find((x) => x.label === label);
    return mockBridge.runAction({ projectId: p.id, actionId: a.id }, 'agent', reason);
  },
  agent(index = 0, reason = 'Fix checkout rounding bug') {
    const p = projects[index];
    return mockBridge.deploy({ projectId: p.id, commandId: p.activeCommandId }, 'agent', reason);
  },
  failNext(index) { failNext.add(projects[index].id); },
  emit,
};
