import { app, BrowserWindow, globalShortcut, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification, screen, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Runner, TERMINAL } from './runner.mjs';
import { detectProject, fileToDataUrl, suggestActions } from './detect.mjs';
import { fetchFavicon } from './favicon.mjs';
import { createMcp } from './mcp.mjs';
import { createBar } from './bar.mjs';
import { Usage } from './usage.mjs';
import { loadShellEnv } from './shellenv.mjs';
import { loadPackDir, packCatalog, resolvePack, packLocked, installPackFile, removePackFile, DEFAULT_PACK_ID } from './packs.mjs';
import { License } from './license.mjs';
import { loadPro } from './extensions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

if (process.env.PLOINK_USER_DATA) app.setPath('userData', process.env.PLOINK_USER_DATA);
if (!app.requestSingleInstanceLock()) app.exit(0);
app.setName('Ploink');

let win = null;
let tray = null;
let quitting = false;
let dialogOpen = false;
let store;
let runner;
let mcp;
let bar;
let usage;
let license;
let pro = null; // the private Pro module, only in official builds
let catalog = [];
let shortcutState = { ok: true, error: null };

// ---------- helpers ----------
const send = (type, payload = {}) => {
  if (win && !win.isDestroyed()) win.webContents.send('ploink:event', { type, ...payload });
  bar?.send(type, payload);
};
const consoleFocused = () => !!(win && !win.isDestroyed() && win.isVisible() && win.isFocused());
// which window speaks (plays result sounds) right now
const voiceNow = () => (consoleFocused() ? 'console' : store.settings.bar?.enabled ? 'bar' : 'console');

function actionRuns() {
  const out = {};
  for (const p of store.projects) {
    for (const a of p.actions || []) {
      const r = runner.latestActionRun(p.id, a.id);
      if (r) (out[p.id] ||= {})[a.id] = runner.summary(r);
    }
  }
  return out;
}

// ---------- look: button packs + Pro ----------
const userPackDir = () => path.join(app.getPath('userData'), 'packs');

function rebuildCatalog() {
  catalog = packCatalog({
    builtin: loadPackDir(path.join(ROOT, 'packs')),
    pro: pro?.packs || [],
    community: loadPackDir(userPackDir()),
  });
}

function lookState() {
  const unlocked = license.active;
  return {
    pack: resolvePack(catalog, store.settings.pack, { pro: unlocked }),
    packs: catalog.map((p) => ({ ...p, locked: packLocked(p, unlocked) })),
    license: license.view(),
    proBuild: !!pro,
    proVersion: pro?.version || '',
  };
}

const sendLook = () => send('look', { look: lookState() });

async function refreshLicense(force = false) {
  const res = await license.refresh({ force }).catch(() => null);
  if (res?.changed || force) sendLook();
  return res;
}

function publicState() {
  const latest = {};
  for (const p of store.projects) latest[p.id] = runner.summary(runner.latestRunFor(p.id));
  return {
    projects: store.projects,
    settings: store.settings,
    latest,
    actions: actionRuns(),
    mcp: mcp.state,
    shortcut: shortcutState,
    platform: process.platform,
    appPath: ROOT.replace(/app\.asar(?=$|\/)/, 'app.asar.unpacked'),
    version: app.getVersion(),
    look: lookState(),
  };
}

const detectSuggestions = (dir, url) => suggestActions(dir, { url });

function logActivity(event) {
  const e = store.addActivity(event);
  send('activity', { event: e });
  return e;
}

// turn run status changes into plain activity entries
const lastStatus = new Map();
const lastCheck = new Map(); // `${projectId}:${actionId}` -> 'success' | 'failed'
function recordRunActivity(run) {
  const prev = lastStatus.get(run.id);
  if (prev === run.status) return;
  lastStatus.set(run.id, run.status);
  if (lastStatus.size > 500) lastStatus.delete(lastStatus.keys().next().value);
  const action = !!run.actionId;
  const base = { projectId: run.projectId, projectName: run.projectName, runId: run.id, command: run.commandLabel, source: run.source, reason: run.reason || undefined, ...(action ? { kind: run.kind, actionId: run.actionId } : {}), ...(run.client ? { client: run.client } : {}) };
  const took = run.startedAt && run.endedAt ? run.endedAt - run.startedAt : undefined;
  // checks are quiet: they only log when the result changes (OK -> FAIL or back), so a
  // frequent health check cannot flood the log
  if (run.kind === 'check' && run.source !== 'agent') {
    if (!['success', 'failed'].includes(run.status)) return undefined;
    const key = `${run.projectId}:${run.actionId}`;
    const before = lastCheck.get(key) ?? store.history.find((r) => r.actionId === run.actionId && r.id !== run.id && ['success', 'failed'].includes(r.status))?.status;
    lastCheck.set(key, run.status);
    if (before === run.status) return undefined;
  }
  if (run.status === 'stopped') return logActivity({ ...base, type: 'stopped', durationMs: took });
  if (run.status === 'success' && run.value) base.value = run.value;
  if (run.status === 'failed' && (run.value || run.verify?.value)) base.value = run.value || run.verify.value;
  if (run.verify) base.site = { ok: run.verify.ok, value: run.verify.value };
  switch (run.status) {
    case 'awaiting_approval': return logActivity({ ...base, type: 'requested' });
    case 'starting': if (prev === 'awaiting_approval') logActivity({ ...base, type: 'approved' }); return;
    case 'running': return logActivity({ ...base, type: 'started' });
    case 'success': return logActivity({ ...base, type: 'succeeded', durationMs: took });
    case 'failed': return logActivity({ ...base, type: 'failed', exitCode: run.exitCode, durationMs: took, detail: run.lastLine || undefined });
    case 'cancelled': return logActivity({ ...base, type: 'cancelled', durationMs: took });
    case 'denied': return logActivity({ ...base, type: 'denied' });
    case 'expired': return logActivity({ ...base, type: 'expired' });
    default: return undefined;
  }
}

// a human approved (or edited) a command an agent added: it no longer needs review
function trustButton(projectId, { commandId, actionId }) {
  const p = store.getProject(projectId);
  if (!p) return false;
  let hit = false;
  const commands = p.commands.map((c) => (commandId && c.id === commandId ? ((hit = true), { ...c, trusted: true }) : c));
  const actions = (p.actions || []).map((a) => (actionId && a.id === actionId ? ((hit = true), { ...a, trusted: true }) : a));
  if (!hit) return false;
  store.upsertProject({ id: p.id, commands, actions });
  broadcastProjects();
  return true;
}

function broadcastProjects() {
  send('projects', { projects: store.projects });
  bar?.projectsChanged();
  updateTray();
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 620,
    minHeight: 480,
    show: false,
    title: 'Ploink',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    backgroundColor: '#111214',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(ROOT, 'renderer/index.html'));
  win.once('ready-to-show', () => {
    if (!process.env.PLOINK_HIDDEN) win.show();
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });
  win.on('blur', () => {
    if (store.settings.hideOnBlur && !dialogOpen && !win.webContents.isDevToolsOpened()) {
      setTimeout(() => { if (win && !win.isFocused() && !dialogOpen) hideWindow(); }, 120);
    }
  });
  win.on('focus', () => send('focus'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // dev hook: `kill -USR2 <pid>` writes a screenshot of the window into PLOINK_SHOTS
  if (process.env.PLOINK_SHOTS) {
    process.on('SIGUSR1', () => onShortcut()); // dev: simulate the global shortcut
    let n = 0;
    process.on('SIGUSR2', async () => {
      const id = String(++n).padStart(2, '0');
      if (win.isVisible()) fs.writeFileSync(path.join(process.env.PLOINK_SHOTS, `shot-${id}.png`), (await win.webContents.capturePage()).toPNG());
      const b = await bar?.capture();
      if (b && bar.visible) fs.writeFileSync(path.join(process.env.PLOINK_SHOTS, `bar-${id}.png`), b.toPNG());
    });
  }

  if (process.env.PLOINK_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.PLOINK_SCREENSHOT, img.toPNG());
        if (process.env.PLOINK_SCREENSHOT_QUIT) { quitting = true; app.quit(); }
      }, Number(process.env.PLOINK_SCREENSHOT_DELAY) || 1800);
    });
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const b = win.getBounds();
  const wa = display.workArea;
  const onDisplay = b.x >= wa.x - 50 && b.y >= wa.y - 50 && b.x + b.width <= wa.x + wa.width + 50 && b.y + b.height <= wa.y + wa.height + 50;
  if (!onDisplay) {
    const width = Math.min(b.width, wa.width - 40);
    const height = Math.min(b.height, wa.height - 40);
    win.setBounds({ x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2.4), width, height });
  }
  const wasHidden = !win.isVisible();
  if (wasHidden) win.setOpacity(0);
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (win.webContents) win.webContents.send('ploink:event', { type: 'summoned' });
  if (wasHidden) fadeWindow(1, 170);
}

let fadeTimer = null;
function fadeWindow(to, ms, done) {
  clearInterval(fadeTimer);
  const from = win.getOpacity();
  const start = Date.now();
  fadeTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(fadeTimer);
    const t = Math.min(1, (Date.now() - start) / ms);
    const e = 1 - Math.pow(1 - t, 3);
    win.setOpacity(from + (to - from) * e);
    if (t >= 1) { clearInterval(fadeTimer); done?.(); }
  }, 12);
}

function hideWindow() {
  if (!win || !win.isVisible()) return;
  fadeWindow(0, 120, () => {
    win.hide();
    win.setOpacity(1);
    if (process.platform === 'darwin' && !bar?.visible) app.hide();
  });
}

function onShortcut() {
  if (store.settings.bar?.enabled && store.settings.shortcutOpens !== 'console' && bar) {
    bar.toggleSummon();
  } else toggleWindow();
}

function openConsole({ projectId, runId, edit, settings } = {}) {
  showWindow();
  if (settings) send('open-settings', { focus: settings });
  else if (edit && projectId) send('edit-project', { projectId });
  else if (projectId) send('open-log', { projectId, runId });
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) hideWindow();
  else showWindow();
}

function registerShortcut(accelerator) {
  globalShortcut.unregisterAll();
  if (!accelerator) return (shortcutState = { ok: true, error: null });
  try {
    const ok = globalShortcut.register(accelerator, onShortcut);
    shortcutState = ok ? { ok: true, error: null } : { ok: false, error: `${accelerator} is already used by another app.` };
  } catch (err) {
    shortcutState = { ok: false, error: `${accelerator} is not a valid shortcut.` };
  }
  return shortcutState;
}

// ---------- tray ----------
const SPIN = ['◐', '◓', '◑', '◒'];
let spinIndex = 0;
let spinTimer = null;
let trayAlert = null; // 'failed' | 'approval' | null

function updateTray() {
  if (!tray) return;
  // a dev server runs for hours: it should not spin the menu bar icon
  const active = [...runner.runs.values()].filter((r) => !TERMINAL.has(r.status) && r.kind !== 'service');
  const waiting = active.filter((r) => r.status === 'awaiting_approval').length;
  const running = active.length - waiting;
  if (running && !spinTimer) {
    spinTimer = setInterval(() => { spinIndex = (spinIndex + 1) % SPIN.length; updateTray(); }, 180);
  } else if (!running && spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
  }
  let title = '';
  if (running) title = ` ${SPIN[spinIndex]} ${running}`;
  else if (waiting) title = ' ● ask';
  else if (trayAlert === 'failed') title = ' ✕';
  tray.setTitle(title, { fontType: 'monospacedDigit' });
  tray.setToolTip(running ? `Ploink: ${running} deploying` : 'Ploink');
}

function buildTrayMenu() {
  const items = [
    { label: 'Open Ploink console', click: showWindow },
    ...(store.settings.bar?.enabled ? [{ label: 'Show launch bar', accelerator: store.settings.shortcutOpens !== 'console' ? store.settings.shortcut || undefined : undefined, click: () => bar?.toggleSummon() }] : []),
    { type: 'separator' },
  ];
  if (!store.projects.length) items.push({ label: 'No projects yet', enabled: false });
  for (const p of store.projects) {
    const active = runner.activeRunFor(p.id);
    const last = runner.latestRunFor(p.id);
    const status = active ? (active.status === 'awaiting_approval' ? '● waiting for you' : '◐ deploying…') : last ? ({ success: '✓', failed: '✕', cancelled: '–' }[last.status] || '') : '';
    const submenu = p.commands.map((c) => ({
      label: c.trusted === false ? `Review ${c.label} (added by an agent)…` : `Deploy ${c.label}`,
      enabled: !active || c.trusted === false,
      click: () => (c.trusted === false ? openConsole({ projectId: p.id, edit: true }) : startDeploy(p.id, c.id, 'tray')),
    }));
    if (p.actions?.length) {
      submenu.push({ type: 'separator' });
      for (const a of p.actions) {
        const live = runner.activeRunFor(p.id, a.id);
        const last = runner.latestActionRun(p.id, a.id);
        const tag = live ? (a.kind === 'service' ? '  ● running' : '  …') : last?.value ? `  ${last.value}` : '';
        submenu.push({
          label: a.trusted === false ? `Review ${a.label} (added by an agent)…` : live && a.kind === 'service' ? `Stop ${a.label}` : `${a.label}${tag}`,
          enabled: !(live && a.kind !== 'service'),
          click: () => (a.trusted === false ? openConsole({ projectId: p.id, edit: true }) : live ? runner.cancel(live.id) : startAction(p.id, a.id, 'tray')),
        });
      }
    }
    if (active?.status === 'awaiting_approval') submenu.unshift({ label: 'Approve agent request', click: () => runner.approve(active.id) }, { type: 'separator' });
    if (active && active.status !== 'awaiting_approval') submenu.push({ type: 'separator' }, { label: 'Cancel deploy', click: () => runner.cancel(active.id) });
    items.push({ label: `${p.name}  ${status}`.trim(), submenu: submenu.length ? submenu : [{ label: 'No commands', enabled: false }] });
  }
  items.push({ type: 'separator' }, { label: 'Quit Ploink', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } });
  return Menu.buildFromTemplate(items);
}

function createTray() {
  const iconFile = path.join(ROOT, 'build/trayTemplate.png');
  const img = fs.existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty();
  img.setTemplateImage(true);
  tray = new Tray(img);
  if (img.isEmpty()) tray.setTitle('▲');
  tray.on('click', () => { trayAlert = null; updateTray(); tray.popUpContextMenu(buildTrayMenu()); });
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  updateTray();
}

// ---------- deploys and action keys ----------
function startDeploy(projectId, commandId, source = 'user', reason = '') {
  const project = store.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  const res = runner.request({ project, commandId, source, reason });
  return { error: res.error, review: res.review, run: runner.summary(res.run) };
}

function startAction(projectId, actionId, source = 'user') {
  const project = store.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  const res = runner.request({ project, actionId, source });
  return { error: res.error, review: res.review, run: runner.summary(res.run) };
}

function notify(title, body, onClick) {
  if (!store.settings.systemNotifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function addProjectFromPath({ path: dir, name, command, command_label, url }, source = 'agent') {
  if (!dir || !path.isAbsolute(dir)) throw new Error('Pass an absolute folder path.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  const existing = store.projects.find((p) => p.cwd === dir);
  if (existing) throw new Error(`${existing.name} is already in Ploink.`);
  const found = detectProject(dir);
  // Anything an agent adds is untrusted until a human looks at it: an agent can write the
  // package.json it points us at, so even detected scripts need a first approval.
  const trusted = source !== 'agent';
  const commands = (command ? [{ label: command_label || 'deploy', cmd: command }] : found.commands).map((c) => ({ ...c, trusted }));
  const finalUrl = url || found.url;
  const actions = [...(found.actions || [])];
  if (finalUrl && !actions.some((a) => a.kind === 'check')) actions.unshift(...detectSuggestions(dir, finalUrl));
  for (const a of actions) a.trusted = trusted;
  let icon = found.icon;
  if (!icon && finalUrl) icon = await fetchFavicon(finalUrl);
  const project = store.upsertProject({ name: name || found.name, cwd: dir, url: finalUrl, icon, commands, actions });
  logActivity({ type: 'added', projectId: project.id, projectName: project.name, source });
  broadcastProjects();
  send('project-added', { id: project.id });
  return project;
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('state:get', () => publicState());

  ipcMain.handle('project:save', (_e, input) => {
    const isNew = !input.id || !store.getProject(input.id);
    const project = store.upsertProject(input);
    if (isNew) logActivity({ type: 'added', projectId: project.id, projectName: project.name, source: 'user' });
    broadcastProjects();
    return project;
  });
  ipcMain.handle('project:delete', (_e, id) => {
    for (const run of runner.activeRunsFor(id)) runner.cancel(run.id);
    const gone = store.getProject(id);
    store.deleteProject(id);
    if (gone) logActivity({ type: 'removed', projectId: id, projectName: gone.name, source: 'user' });
    broadcastProjects();
    return true;
  });
  ipcMain.handle('project:reorder', (_e, ids) => { store.reorder(ids); broadcastProjects(); return true; });
  ipcMain.handle('project:detect', (_e, dir) => detectProject(dir));
  ipcMain.handle('project:addPath', async (_e, dir) => {
    try { return { project: await addProjectFromPath({ path: dir }, 'user') }; } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    dialogOpen = true;
    try {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], buttonLabel: 'Add to Ploink' });
      return r.canceled ? null : r.filePaths[0];
    } finally { dialogOpen = false; }
  });
  ipcMain.handle('dialog:pickIcon', async () => {
    dialogOpen = true;
    try {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'svg', 'ico', 'jpg', 'jpeg', 'webp', 'gif'] }] });
      return r.canceled ? null : fileToDataUrl(r.filePaths[0], 2 * 1024 * 1024);
    } finally { dialogOpen = false; }
  });
  ipcMain.handle('icon:fetch', (_e, url) => fetchFavicon(url));

  ipcMain.handle('deploy:start', (_e, { projectId, commandId }) => startDeploy(projectId, commandId, 'user'));
  ipcMain.handle('action:start', (_e, { projectId, actionId }) => startAction(projectId, actionId, 'user'));
  ipcMain.handle('run:trust', (_e, { projectId, commandId, actionId }) => trustButton(projectId, { commandId, actionId }));
  ipcMain.handle('deploy:cancel', (_e, runId) => runner.cancel(runId));
  ipcMain.handle('deploy:approve', (_e, runId) => runner.approve(runId));
  ipcMain.handle('mcp:addClient', (_e, name) => { const c = store.addClient(name); send('settings', { settings: store.settings }); return c; });
  ipcMain.handle('mcp:removeClient', (_e, id) => { store.removeClient(id); send('settings', { settings: store.settings }); return true; });
  ipcMain.handle('deploy:deny', (_e, runId) => runner.deny(runId));
  ipcMain.handle('run:get', (_e, runId) => {
    const run = runner.getRun(runId);
    if (!run) return null;
    return { ...runner.summary(run), log: run.log || [] };
  });
  ipcMain.handle('history:get', (_e, projectId) => {
    const live = [...runner.runs.values()].filter((r) => r.projectId === projectId && !TERMINAL.has(r.status)).map((r) => runner.summary(r));
    const past = store.historyFor(projectId).map(({ log, ...r }) => r);
    return [...live, ...past];
  });

  ipcMain.handle('settings:save', async (_e, patch) => {
    const prev = store.settings;
    const settings = store.updateSettings(patch);
    let result = {};
    if (patch.shortcut !== undefined) result.shortcut = registerShortcut(settings.shortcut);
    if ((patch.mcpPort !== undefined && patch.mcpPort !== prev.mcpPort) || (patch.mcpEnabled !== undefined && patch.mcpEnabled !== prev.mcpEnabled)) {
      if (settings.mcpEnabled) await mcp.start(Number(settings.mcpPort)); else mcp.stop();
      send('mcp', { mcp: mcp.state });
    }
    if (patch.launchAtLogin !== undefined && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin });
    if (patch.bar || patch.shortcutOpens || patch.barLabels !== undefined || patch.usage) bar?.applySettings();
    send('settings', { settings });
    if (patch.pack !== undefined) sendLook();
    return { settings, shortcut: shortcutState, mcp: mcp.state, ...result };
  });

  ipcMain.handle('usage:get', () => usage.snapshot());
  ipcMain.handle('usage:refresh', () => usage.refresh());
  ipcMain.handle('usage:open', (_e, provider) => { const u = usage.snapshot()[provider]; if (u?.url) shell.openExternal(u.url); return true; });
  ipcMain.handle('usage:connectClaude', async () => {
    const plan = usage.claudePlan();
    dialogOpen = true;
    try {
      const { response } = await dialog.showMessageBox(win && win.isVisible() ? win : undefined, {
        type: 'question',
        buttons: ['Connect', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: 'Connect Claude Code usage to Ploink?',
        detail: `Ploink will change "statusLine" in ${plan.settingsPath}.\n\nNow: ${plan.before || '(none)'}\nAfter: ${plan.after}\n\nThe new command saves only the usage percentages (rate_limits) for the gauge${plan.chained ? ', then runs your current status line command so it keeps working' : ''}. Disconnect puts the old value back.`,
      });
      if (response !== 0) return { ok: false, cancelled: true };
    } finally { dialogOpen = false; }
    try { return usage.connectClaude(); } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('usage:disconnectClaude', () => { try { return usage.disconnectClaude(); } catch (err) { return { ok: false, error: err.message }; } });
  ipcMain.handle('look:get', () => lookState());
  ipcMain.handle('license:activate', async (_e, key) => {
    const res = await license.activate(String(key || '').slice(0, 200));
    if (res.ok) sendLook();
    return { ...res, look: lookState() };
  });
  ipcMain.handle('license:deactivate', () => { license.deactivate(); sendLook(); return lookState(); });
  ipcMain.handle('license:refresh', async () => { await refreshLicense(true); return lookState(); });
  ipcMain.handle('pack:install', (_e, file) => {
    const res = installPackFile(String(file || ''), userPackDir());
    if (res.error) return { error: res.error };
    rebuildCatalog();
    store.updateSettings({ pack: res.pack.id });
    send('settings', { settings: store.settings });
    sendLook();
    return { pack: { id: res.pack.id, name: res.pack.name }, warnings: res.warnings, look: lookState() };
  });
  ipcMain.handle('pack:remove', (_e, id) => {
    const ok = removePackFile(String(id || ''), userPackDir());
    rebuildCatalog();
    if (store.settings.pack === id) { store.updateSettings({ pack: DEFAULT_PACK_ID }); send('settings', { settings: store.settings }); }
    sendLook();
    return { ok, look: lookState() };
  });
  ipcMain.handle('activity:get', (_e, limit = 400) => store.activity.slice(0, limit));
  ipcMain.handle('app:hide', () => hideWindow());
  ipcMain.handle('app:copy', (_e, textValue) => { clipboard.writeText(String(textValue)); return true; });
  ipcMain.handle('app:reveal', (_e, dir) => { if (dir && fs.existsSync(dir)) shell.openPath(dir); return true; });
  ipcMain.handle('app:openUrl', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
  ipcMain.handle('app:pauseShortcut', (_e, paused) => {
    // while recording a new shortcut in settings, release the current one
    if (paused) globalShortcut.unregisterAll(); else registerShortcut(store.settings.shortcut);
    return true;
  });
}

function setupMenu() {
  const template = [
    {
      label: 'Ploink',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => { showWindow(); send('open-settings'); } },
        { label: 'Add Project…', accelerator: 'Cmd+N', click: () => { showWindow(); send('add-project'); } },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Ploink', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- boot ----------
app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  runner?.stopAll();
  mcp?.stop();
  usage?.stop();
  store?.flush();
  store?.flushHistory();
  store?.flushActivity();
});

// Ploink used to be called Liftoff. Bring its projects and history along, once.
function migrateFromLiftoff(dir) {
  if (fs.existsSync(path.join(dir, 'ploink-config.json'))) return;
  const legacyDirs = [dir, path.join(app.getPath('appData'), 'Liftoff')];
  for (const [from, to] of [['liftoff-config.json', 'ploink-config.json'], ['liftoff-history.json', 'ploink-history.json']]) {
    const src = legacyDirs.map((d) => path.join(d, from)).find((f) => fs.existsSync(f));
    if (!src) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, to));
  }
}

app.whenReady().then(async () => {
  migrateFromLiftoff(app.getPath('userData'));
  store = new Store(app.getPath('userData'));
  runner = new Runner(store);
  license = new License({ dir: app.getPath('userData') });
  pro = await loadPro(ROOT);
  rebuildCatalog();
  loadShellEnv(); // warm up in the background

  usage = new Usage({ dir: app.getPath('userData') });
  let gaugeSig = '';
  usage.on('update', (u) => {
    send('usage', { usage: u });
    const sig = `${u.claude.available}${u.codex.available}`;
    if (sig !== gaugeSig) { gaugeSig = sig; bar?.projectsChanged(); }
  });
  usage.start();

  let lastUnauthorized = 0;
  mcp = createMcp({
    store,
    runner,
    getUsage: () => usage.snapshot(),
    onAddProject: addProjectFromPath,
    onAgentActivity: () => {},
    onUnauthorized: (info) => {
      // tell the user once a minute at most: usually an agent set up before tokens existed
      if (Date.now() - lastUnauthorized < 60_000) return;
      lastUnauthorized = Date.now();
      send('mcp-unauthorized', info);
    },
  });
  runner.on('trusted', (run) => trustButton(run.projectId, { commandId: run.commandId, actionId: run.actionId }));

  runner.on('update', (run) => {
    send('run', { run: { ...run, voice: voiceNow() } });
    recordRunActivity(run);
    bar?.onRunUpdate(run);
    updateTray();
  });
  runner.on('log', (payload) => send('log', payload));
  runner.on('approval', (run) => {
    // action-key requests are approved on the key itself, in the console
    if (run.actionId || consoleFocused() || !bar?.request(run)) showWindow();
    const what = run.actionId ? `press ${run.commandLabel} on ${run.projectName}` : `deploy ${run.projectName}`;
    notify(`Agent wants to ${what}`, run.reason || `${run.commandLabel}: hold the button to approve`, showWindow);
  });
  runner.on('finished', (run) => {
    if (run.status === 'failed' && !run.actionId) trayAlert = 'failed';
    updateTray();
    if (run.actionId) return; // action keys report on their own key and readout, not with a banner
    if (consoleFocused()) return;
    if (['success', 'failed'].includes(run.status) && store.settings.announce) bar?.announce(run);
    const took = run.startedAt ? fmtDuration(run.endedAt - run.startedAt) : '';
    if (run.status === 'success') notify(`${run.projectName} shipped`, `${run.commandLabel} · ${took}`, () => { showWindow(); send('open-run', { runId: run.id }); });
    else if (run.status === 'failed') notify(`${run.projectName} deploy failed`, `exit ${run.exitCode} · ${took}`, () => { showWindow(); send('open-run', { runId: run.id }); });
  });

  setupIpc();
  setupMenu();
  createWindow();
  bar = createBar({
    root: ROOT,
    preload: path.join(__dirname, 'preload.cjs'),
    store,
    hooks: {
      openConsole,
      gaugeCount: () => {
        const u = usage.snapshot();
        const on = store.settings.usage || {};
        return (on.claude !== false && u.claude.available ? 1 : 0) + (on.codex !== false && u.codex.available ? 1 : 0);
      },
      openUrl: (url) => shell.openExternal(/^https?:/.test(url) ? url : `https://${url}`),
      setActiveCommand: (projectId, commandId) => { store.upsertProject({ id: projectId, activeCommandId: commandId }); broadcastProjects(); },
      runAction: (projectId, actionId) => {
        const live = runner.activeRunFor(projectId, actionId);
        if (live) return runner.cancel(live.id);
        const res = startAction(projectId, actionId, 'user');
        if (res.review) openConsole({ projectId, edit: true });
        return res;
      },
      actionState: (projectId, actionId) => ({ live: runner.activeRunFor(projectId, actionId), last: runner.latestActionRun(projectId, actionId) }),
    },
  });
  bar.init();
  createTray();
  registerShortcut(store.settings.shortcut);
  if (store.settings.mcpEnabled) await mcp.start(Number(store.settings.mcpPort));
  send('mcp', { mcp: mcp.state });
  try { pro?.activate?.({ store, runner, mcp, license, send, ipcMain }); } catch (err) { console.error('[ploink] Pro activate failed:', err); }
  // re-check the Pro license shortly after launch, then every few hours (it only calls out once a day)
  setTimeout(() => refreshLicense(), 8000);
  setInterval(() => refreshLicense(), 3 * 3600e3);

  const dockIcon = path.join(ROOT, 'build/icon.png');
  if (process.platform === 'darwin' && !app.isPackaged && fs.existsSync(dockIcon)) app.dock?.setIcon(dockIcon);
});
