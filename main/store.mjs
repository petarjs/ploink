// Persistent config + run history, stored as JSON in Electron's userData folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_SETTINGS = {
  shortcut: 'F5',
  holdMs: 650,
  sound: true,
  volume: 0.7,
  mcpEnabled: true,
  mcpPort: 47321,
  mcpAuth: 'token', // 'token' = agents need a client token, 'off' = any local program may connect
  mcpClients: [], // [{ id, name, token, createdAt, lastUsedAt }]
  agentApproval: 'auto', // 'auto' = agents deploy straight away, 'ask' = you approve each one
  systemNotifications: false, // macOS notification banners; the launch bar announces results instead
  announce: true, // slide the launch bar in to show a finished deploy
  shortcutOpens: 'bar', // 'bar' | 'console'
  bar: {
    enabled: true,
    edge: 'bottom', // 'bottom' | 'top' | 'left' | 'right' | 'notch'
    visibility: 'shortcut', // 'shortcut' | 'always' | 'edge'
    size: 'medium', // 'small' | 'medium' | 'large'
    style: 'mini', // 'mini' (floating strip) | 'cockpit' (big console flush with the screen edge)
  },
  buttonShape: 'round', // 'round' | 'square'
  pack: 'dev.ploink.mission-control', // button pack id (see main/packs.mjs)
  iconScale: 0.5, // icon medal size as a share of the button
  barLabels: true, // project names under the launch bar buttons
  usage: { claude: true, codex: true }, // AI plan usage gauges
  hideOnBlur: false,
  launchAtLogin: false,
  deployTimeoutMin: 30,
};

export const uid = (prefix = '') => prefix + crypto.randomBytes(5).toString('hex');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  // owner-only: the config holds agent tokens and the commands that run in your shell
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.configFile = path.join(dir, 'ploink-config.json');
    this.historyFile = path.join(dir, 'ploink-history.json');
    const cfg = readJson(this.configFile, {});
    this.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
    this.settings.bar = { ...DEFAULT_SETTINGS.bar, ...(cfg.settings?.bar || {}) };
    this.settings.usage = { ...DEFAULT_SETTINGS.usage, ...(cfg.settings?.usage || {}) };
    this.settings.mcpClients = normalizeClients(this.settings.mcpClients);
    delete this.settings.notifications;
    this.projects = Array.isArray(cfg.projects) ? cfg.projects.map(normalizeProject) : [];
    this.history = readJson(this.historyFile, []);
    if (!Array.isArray(this.history)) this.history = [];
    this.activityFile = path.join(dir, 'ploink-activity.json');
    this.activity = readJson(this.activityFile, null);
    if (!Array.isArray(this.activity)) this.activity = activityFromHistory(this.history);
    this._saveTimer = null;
    this._histTimer = null;
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this._saveTimer);
    writeJsonAtomic(this.configFile, { version: 1, settings: this.settings, projects: this.projects });
  }

  saveHistory() {
    clearTimeout(this._histTimer);
    this._histTimer = setTimeout(() => this.flushHistory(), 300);
  }

  flushHistory() {
    clearTimeout(this._histTimer);
    writeJsonAtomic(this.historyFile, this.history);
  }

  // Activity: a short, human-readable timeline (deploys, approvals, projects added or removed).
  addActivity(event) {
    const e = { id: uid('a_'), at: Date.now(), ...event };
    this.activity.unshift(e);
    if (this.activity.length > 1000) this.activity.length = 1000;
    clearTimeout(this._actTimer);
    this._actTimer = setTimeout(() => this.flushActivity(), 400);
    return e;
  }

  flushActivity() {
    clearTimeout(this._actTimer);
    writeJsonAtomic(this.activityFile, this.activity);
  }

  getProject(id) {
    return this.projects.find((p) => p.id === id) || null;
  }

  upsertProject(input) {
    const existing = input.id ? this.getProject(input.id) : null;
    const next = normalizeProject({ ...(existing || {}), ...input, id: existing?.id || input.id || uid('p_') });
    if (existing) Object.assign(existing, next);
    else this.projects.push(next);
    this.save();
    return existing || next;
  }

  deleteProject(id) {
    this.projects = this.projects.filter((p) => p.id !== id);
    this.history = this.history.filter((r) => r.projectId !== id);
    this.save();
    this.saveHistory();
  }

  reorder(ids) {
    const byId = new Map(this.projects.map((p) => [p.id, p]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const p of this.projects) if (!ids.includes(p.id)) ordered.push(p);
    this.projects = ordered;
    this.save();
  }

  updateSettings(patch) {
    const { mcpClients, ...rest } = patch; // tokens change only through addClient / removeClient
    const bar = rest.bar ? { ...this.settings.bar, ...rest.bar } : this.settings.bar;
    const usage = rest.usage ? { ...this.settings.usage, ...rest.usage } : this.settings.usage;
    this.settings = { ...this.settings, ...rest, bar, usage };
    this.save();
    return this.settings;
  }

  // ---- agent clients (one token per MCP client, so each can be revoked on its own)
  addClient(name) {
    const client = {
      id: uid('k_'),
      name: String(name || 'Agent').trim().slice(0, 40) || 'Agent',
      token: 'plk_' + crypto.randomBytes(24).toString('base64url'),
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    this.settings = { ...this.settings, mcpClients: [...this.settings.mcpClients, client] };
    this.save();
    return client;
  }

  removeClient(id) {
    this.settings = { ...this.settings, mcpClients: this.settings.mcpClients.filter((c) => c.id !== id) };
    this.save();
  }

  // constant-time match of a bearer token against the known clients
  clientForToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const given = Buffer.from(token);
    let found = null;
    for (const c of this.settings.mcpClients) {
      const want = Buffer.from(c.token);
      if (want.length === given.length && crypto.timingSafeEqual(want, given)) found = c;
    }
    return found;
  }

  touchClient(client) {
    // in memory only; written with the next real save, so a busy agent does not rewrite the config
    if (client) client.lastUsedAt = Date.now();
  }

  addHistory(run) {
    this.history.unshift(run);
    // keep 25 deploys per project, and 5 runs per action key so checks never push deploys out
    const counts = {};
    this.history = this.history.filter((r) => {
      const key = `${r.projectId}:${r.actionId || ''}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts[key] <= (r.actionId ? 5 : 25);
    });
    this.saveHistory();
  }

  historyFor(projectId, limit = 25, { deploysOnly = false } = {}) {
    return this.history.filter((r) => r.projectId === projectId && (!deploysOnly || !r.actionId)).slice(0, limit);
  }
}

function normalizeClients(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c.token === 'string' && c.token.length >= 20)
    .map((c) => ({ id: c.id || uid('k_'), name: String(c.name || 'Agent').slice(0, 40), token: c.token, createdAt: c.createdAt || Date.now(), lastUsedAt: c.lastUsedAt || null }));
}

// Action keys: the smaller buttons under a bay's main button.
// oneshot = runs once (pass/fail), check = shows a value on the readout, service = start/stop (dev server).
export const ACTION_KINDS = ['oneshot', 'check', 'service'];
export const MAX_ACTIONS = 6;

export function normalizeAction(a) {
  const kind = ACTION_KINDS.includes(a.kind) ? a.kind : 'oneshot';
  return {
    id: a.id || uid('x_'),
    label: String(a.label || 'action').trim().slice(0, 12) || 'action',
    kind,
    cmd: String(a.cmd).trim(),
    parse: typeof a.parse === 'string' ? a.parse.slice(0, 200) : '', // optional regex for a check's value
    hold: !!a.hold, // dangerous: hold to run, and agents always ask
    agents: !!a.agents, // agents may press it through MCP
    afterDeploy: kind === 'check' && !!a.afterDeploy, // run after every deploy; SHIPPED waits for it
    trusted: a.trusted !== false, // false = added by an agent, a human has not looked at it yet
  };
}

// First run with an activity log: rebuild a timeline from past deploys.
function activityFromHistory(history) {
  const events = [];
  const finished = { success: 'succeeded', failed: 'failed', cancelled: 'cancelled', denied: 'denied', expired: 'expired' };
  for (const r of history) {
    const base = { projectId: r.projectId, projectName: r.projectName, runId: r.id, command: r.commandLabel, source: r.source, reason: r.reason || undefined };
    if (r.startedAt) events.push({ ...base, id: `a_${r.id}_s`, at: r.startedAt, type: 'started' });
    if (r.endedAt && finished[r.status]) {
      events.push({
        ...base, id: `a_${r.id}_e`, at: r.endedAt, type: finished[r.status],
        exitCode: r.exitCode ?? undefined,
        durationMs: r.startedAt ? r.endedAt - r.startedAt : undefined,
      });
    }
  }
  return events.sort((a, b) => b.at - a.at).slice(0, 1000);
}

export function normalizeProject(p) {
  const commands = (Array.isArray(p.commands) ? p.commands : [])
    .filter((c) => c && typeof c.cmd === 'string' && c.cmd.trim())
    .map((c) => ({
      id: c.id || uid('c_'),
      label: String(c.label || 'deploy').trim().slice(0, 24) || 'deploy',
      cmd: c.cmd.trim(),
      trusted: c.trusted !== false,
    }));
  const activeCommandId = commands.some((c) => c.id === p.activeCommandId) ? p.activeCommandId : commands[0]?.id || null;
  const actions = (Array.isArray(p.actions) ? p.actions : [])
    .filter((a) => a && typeof a.cmd === 'string' && a.cmd.trim())
    .slice(0, MAX_ACTIONS)
    .map(normalizeAction);
  return {
    id: p.id,
    name: String(p.name || 'Untitled').trim().slice(0, 40) || 'Untitled',
    cwd: String(p.cwd || ''),
    url: p.url ? String(p.url).trim() : '',
    icon: typeof p.icon === 'string' && p.icon.startsWith('data:') ? p.icon : null,
    color: typeof p.color === 'string' ? p.color : null,
    commands,
    activeCommandId,
    actions,
    requireApproval: !!p.requireApproval,
    bank: String(p.bank || '').trim().slice(0, 24),
    createdAt: p.createdAt || Date.now(),
  };
}
