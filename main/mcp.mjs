// A small Model Context Protocol server (Streamable HTTP, stateless, JSON responses).
// Agents connect to http://127.0.0.1:<port>/mcp and can list projects, deploy, wait and read logs.
import http from 'node:http';
import path from 'node:path';
import { stripAnsi, TERMINAL } from './runner.mjs';
import { commandSteps, commandDisplay } from '../renderer/steps.js';

const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const LATEST = SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1];

const INSTRUCTIONS = `Ploink is the user's local deployment cockpit. Each project has one or more deploy commands that run on the user's Mac, and may have small action keys (for example a site health check, a dev server, git pull) that the user allowed agents to press.
Typical flow: call list_projects (or pass your working directory as "project"), then deploy (or press for an action key), then wait_for_deploy until the status is final.
A run can be "awaiting_approval": the user approves agent requests for commands an agent added, for hold-to-run keys, and when they asked to approve agent deploys. Tell the user to press the glowing button in Ploink.
You cannot run arbitrary shell commands through Ploink; only the buttons the user set up.`;

const TOOLS = [
  {
    name: 'list_projects',
    title: 'List deploy projects',
    description: 'List every project in Ploink with its folder, website, deploy commands, the action keys agents may press, and the status of its latest deploy.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'deploy',
    title: 'Deploy a project',
    description: 'Start a deploy. "project" can be the project name, its id, or an absolute path inside the project folder (for example your current working directory). Returns a run_id right away; call wait_for_deploy to follow it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, id, or a path inside the project folder.' },
        command: { type: 'string', description: 'Optional command label or id (for example "prod" or "preview"). Defaults to the command selected in the app.' },
        reason: { type: 'string', description: 'Short note shown in the app, for example "fix checkout bug".' },
        wait: { type: 'boolean', description: 'If true, wait for the deploy to finish (up to timeout_seconds) before returning.' },
        timeout_seconds: { type: 'number', description: 'Max seconds to wait when wait=true. Default 300, max 900.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'press',
    title: 'Press an action key',
    description: 'Press one of a project\'s action keys (as listed by list_projects under "actions"), for example "health", "pull" or "dev". A check returns a value (for example "200 · 0.21s"). Pressing a running service (like a dev server) stops it. Returns a run_id; pass wait=true to get the result in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, id, or a path inside the project folder.' },
        key: { type: 'string', description: 'The action key label or id, for example "health".' },
        reason: { type: 'string', description: 'Short note shown in the app.' },
        wait: { type: 'boolean', description: 'Wait for the run to finish (up to timeout_seconds). Services return as soon as they start.' },
        timeout_seconds: { type: 'number', description: 'Max seconds to wait when wait=true. Default 120, max 900.' },
      },
      required: ['project', 'key'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'wait_for_deploy',
    title: 'Wait for a run',
    description: 'Wait until a deploy or action run finishes or the timeout passes, then return its status and the last lines of output. Call again if it is still running.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        timeout_seconds: { type: 'number', description: 'Default 120, max 900.' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_deploy_logs',
    title: 'Read deploy logs',
    description: 'Return the output of a deploy or action run. Pass run_id, or project to get its latest deploy.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        project: { type: 'string' },
        lines: { type: 'number', description: 'How many lines from the end. Default 200.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cancel_deploy',
    title: 'Cancel a deploy',
    description: 'Stop a running deploy or action (or withdraw a request that waits for approval).',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'], additionalProperties: false },
    annotations: { destructiveHint: true },
  },
  {
    name: 'add_project',
    title: 'Add a project to Ploink',
    description: 'Add a project folder to Ploink. Ploink detects the name, deploy scripts, website and icon. Pass command to set the deploy command explicitly. Commands added by an agent need the user\'s approval on their first run.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the project folder.' },
        name: { type: 'string' },
        command: { type: 'string', description: 'Shell command that deploys this project, for example "npm run deploy".' },
        command_label: { type: 'string', description: 'Short label for the command, for example "prod".' },
        url: { type: 'string', description: 'Website URL, used to fetch the favicon.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'ai_usage',
    title: 'AI plan usage',
    description: "How much of the user's Claude and Codex (ChatGPT) plan limits is used: percent of each window (5-hour, weekly) and when it resets. Useful before starting a long agent task.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'recent_activity',
    title: 'Recent activity',
    description: 'A plain-English timeline of what happened in Ploink: deploys started, shipped, failed or cancelled, agent approval requests, and projects added or removed. Newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional: only this project (name, id or a path inside it).' },
        limit: { type: 'number', description: 'How many entries. Default 30, max 200.' },
        failures_only: { type: 'boolean', description: 'Only failed deploys.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'deploy_history',
    title: 'Deploy history',
    description: 'Recent deploys of a project with status, duration and who started them.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, limit: { type: 'number', description: 'Default 10.' } },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const BY = { user: 'you', agent: 'an agent', tray: 'you (menu bar)' };
export function describeActivity(e) {
  const who = BY[e.source] || 'you';
  const secs = e.durationMs != null ? ` in ${Math.round(e.durationMs / 1000)}s` : '';
  const cmd = e.command && e.command !== 'deploy' ? ` (${e.command})` : '';
  if (e.kind && e.kind !== 'deploy') {
    const key = e.command || 'action';
    switch (e.type) {
      case 'started': return `${e.projectName}: ${key} ${e.kind === 'service' ? 'started' : 'ran'}, by ${who}${e.reason ? `: "${e.reason}"` : ''}`;
      case 'succeeded': return `${e.projectName}: ${key} ${e.kind === 'check' ? `OK${e.value ? ` (${e.value})` : ''}` : 'done'}${secs}`;
      case 'failed': return `${e.projectName}: ${key} ${e.kind === 'service' ? 'crashed' : 'failed'}, exit ${e.exitCode ?? '?'}${e.value ? ` (${e.value})` : e.detail ? ` — ${e.detail}` : ''}`;
      case 'stopped': return `${e.projectName}: ${key} stopped${secs}`;
      case 'cancelled': return `${e.projectName}: ${key} cancelled`;
      case 'requested': return `${e.projectName}: an agent asked to press ${key}${e.reason ? `: "${e.reason}"` : ''}`;
      case 'approved': return `${e.projectName}: you approved the agent's ${key}`;
      case 'denied': return `${e.projectName}: the agent's ${key} request was denied`;
      case 'expired': return `${e.projectName}: the agent's ${key} request expired`;
      default: return `${e.projectName}: ${key} ${e.type}`;
    }
  }
  switch (e.type) {
    case 'started': return `${e.projectName}: deploy${cmd} started by ${who}${e.reason ? `: "${e.reason}"` : ''}`;
    case 'succeeded': return e.dryRun ? `${e.projectName}: dry run${cmd} passed${secs}, nothing deployed` : `${e.projectName}: shipped${cmd}${secs}`;
    case 'failed': return `${e.projectName}: deploy${cmd} failed, exit ${e.exitCode ?? '?'}${secs}${e.detail ? ` — ${e.detail}` : ''}`;
    case 'cancelled': return `${e.projectName}: deploy${cmd} cancelled${secs}`;
    case 'requested': return `${e.projectName}: an agent asked to deploy${cmd}${e.reason ? `: "${e.reason}"` : ''}`;
    case 'approved': return `${e.projectName}: you approved the agent's deploy${cmd}`;
    case 'denied': return `${e.projectName}: the agent's deploy request was denied`;
    case 'expired': return `${e.projectName}: the agent's deploy request expired`;
    case 'added': return `${e.projectName}: added to Ploink by ${who}`;
    case 'removed': return `${e.projectName}: removed from Ploink`;
    default: return `${e.projectName}: ${e.type}`;
  }
}

const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : d);
const secs = (ms) => (ms == null ? null : Math.round(ms / 100) / 10);

export function resolveProject(store, ref) {
  if (!ref) return null;
  const q = String(ref).trim();
  const lower = q.toLowerCase();
  const byId = store.projects.find((p) => p.id === q);
  if (byId) return byId;
  const byName = store.projects.find((p) => p.name.toLowerCase() === lower);
  if (byName) return byName;
  if (q.startsWith('/') || q.startsWith('~')) {
    const abs = path.resolve(q.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
    // the deepest project folder that contains the path wins
    const hits = store.projects
      .filter((p) => p.cwd && (abs === p.cwd || abs.startsWith(p.cwd.replace(/\/$/, '') + '/')))
      .sort((a, b) => b.cwd.length - a.cwd.length);
    if (hits[0]) return hits[0];
  }
  const loose = store.projects.filter((p) => p.name.toLowerCase().includes(lower) || path.basename(p.cwd).toLowerCase() === lower);
  return loose.length === 1 ? loose[0] : null;
}

function runReport(run, tail = 40) {
  if (!run) return null;
  const log = run.log || [];
  const duration = run.startedAt ? (run.endedAt || Date.now()) - run.startedAt : null;
  return {
    run_id: run.id,
    project: run.projectName,
    kind: run.kind || 'deploy',
    command: run.commandLabel,
    shell_command: run.cmd,
    dry_run: run.dryRun || undefined,
    status: run.status,
    final: TERMINAL.has(run.status),
    exit_code: run.exitCode,
    value: run.value || undefined,
    url: run.url || undefined,
    site_check: run.verify ? { passed: run.verify.ok, value: run.verify.value } : undefined,
    started_by: run.source === 'agent' && run.client ? `agent (${run.client})` : run.source,
    reason: run.reason || undefined,
    started_at: run.startedAt ? new Date(run.startedAt).toISOString() : null,
    duration_seconds: secs(duration),
    output_tail: tail ? log.slice(-tail).map(stripAnsi).join('\n') : undefined,
  };
}

function text(obj, isError = false) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text: body }], isError };
}

export function createMcp({ store, runner, onAddProject, onAgentActivity, getUsage, onUnauthorized }) {
  const statusLine = (r) => {
    const what = !r.kind || r.kind === 'deploy' ? 'Deploy' : `"${r.commandLabel}"`;
    switch (r.status) {
      case 'awaiting_approval': return `Waiting for the user to approve this ${!r.kind || r.kind === 'deploy' ? 'deploy' : 'key press'} in Ploink (they need to press the glowing button).`;
      case 'running': case 'starting':
        if (r.kind === 'service') return `${what} is running${r.url ? ` at ${r.url}` : ''}. Press it again (or cancel_deploy) to stop it.`;
        if (r.phase === 'verify') return 'Deployed; now checking the site. Call wait_for_deploy with this run_id.';
        return `${what} is running. Call wait_for_deploy with this run_id to follow it.`;
      case 'success': if (r.dryRun) return `"${r.commandLabel}" is a dry run: it passed, but nothing was deployed. To ship, deploy again with the real deploy command (the "command" argument).`;
        return r.kind === 'check' ? `${what} passed: ${r.value || 'OK'}.` : r.verify?.ok ? `Deploy finished and the ${r.verify.label} check passed (${r.verify.value}).` : `${what} finished successfully.`;
      case 'failed':
        if (r.verify && !r.verify.ok) return `The deploy command succeeded, but the ${r.verify.label} check failed (${r.verify.value || 'no response'}). The site may be down.`;
        return `${what} failed. See output_tail, or call get_deploy_logs for the full output.`;
      case 'stopped': return `${what} stopped.`;
      case 'cancelled': return `${what} was cancelled.`;
      case 'denied': return 'The user denied this request.';
      case 'expired': return 'The approval request expired.';
      default: return r.status;
    }
  };

  const findKey = (project, key) => {
    const q = String(key || '').trim().toLowerCase();
    const list = (project.actions || []).filter((a) => a.agents);
    return list.find((a) => a.id === key || a.label.toLowerCase() === q) || list.find((a) => a.label.toLowerCase().includes(q)) || null;
  };

  const tools = {
    async list_projects() {
      const projects = store.projects.map((p) => {
        const last = runner.latestRunFor(p.id);
        const actions = (p.actions || []).filter((a) => a.agents).map((a) => {
          const r = runner.latestActionRun(p.id, a.id);
          return {
            id: a.id,
            label: a.label,
            kind: a.kind,
            command: commandDisplay(a.cmd),
            needs_approval: a.hold || a.trusted === false || store.settings.agentApproval === 'ask',
            latest: r ? { run_id: r.id, status: r.status, value: r.value || undefined, url: r.url || undefined } : null,
          };
        });
        return {
          id: p.id,
          name: p.name,
          bank: p.bank || undefined,
          path: p.cwd,
          url: p.url || undefined,
          commands: p.commands.map((c) => {
            const steps = commandSteps(c.cmd);
            return { id: c.id, label: c.label, command: commandDisplay(c.cmd), steps: steps.length > 1 ? steps : undefined, selected: c.id === p.activeCommandId, needs_first_approval: c.trusted === false || undefined };
          }),
          actions: actions.length ? actions : undefined,
          needs_approval_for_agents: p.requireApproval || store.settings.agentApproval === 'ask',
          latest_deploy: last ? { run_id: last.id, status: last.status, command: last.commandLabel, finished_at: last.endedAt ? new Date(last.endedAt).toISOString() : null } : null,
        };
      });
      if (!projects.length) return text('No projects yet. Use add_project with an absolute folder path to add one.');
      return text({ projects });
    },

    async press(args, ctx) {
      const project = resolveProject(store, args.project);
      if (!project) return text(`No project matches "${args.project}".`, true);
      const action = findKey(project, args.key);
      if (!action) {
        const allowed = (project.actions || []).filter((a) => a.agents).map((a) => a.label);
        return text(`${project.name} has no action key "${args.key}" that agents may press.${allowed.length ? ` Keys you can press: ${allowed.join(', ')}.` : ' The user has not allowed agents to press any of its keys.'}`, true);
      }
      // pressing a running service turns it off
      const live = runner.activeRunFor(project.id, action.id);
      if (live && action.kind === 'service' && live.status !== 'awaiting_approval') {
        runner.cancel(live.id);
        const done = await runner.waitFor(live.id, 6000);
        return text({ ...runReport(done, 5), message: `Stopped ${action.label}.` });
      }
      const { run, error } = runner.request({ project, actionId: action.id, source: 'agent', reason: args.reason, client: ctx?.client?.name });
      if (error) return text({ error, current_run: run ? runReport(run, 10) : undefined }, true);
      if (args.wait && action.kind !== 'service') {
        const done = await runner.waitFor(run.id, clamp(args.timeout_seconds, 5, 900, 120) * 1000);
        return text({ ...runReport(done, 20), message: statusLine(done) }, done.status === 'failed');
      }
      if (args.wait && action.kind === 'service') {
        // give a dev server a moment to print its URL
        await new Promise((r) => setTimeout(r, 4000));
      }
      const now = runner.getRun(run.id);
      return text({ ...runReport(now, 0), message: statusLine(now) });
    },

    async deploy(args, ctx) {
      const project = resolveProject(store, args.project);
      if (!project) {
        const names = store.projects.map((p) => p.name).join(', ') || '(none)';
        return text(`No project matches "${args.project}". Known projects: ${names}. You can add one with add_project.`, true);
      }
      let commandId;
      if (args.command) {
        const q = String(args.command).toLowerCase();
        const cmd = project.commands.find((c) => c.id === args.command || c.label.toLowerCase() === q) ||
          project.commands.find((c) => c.label.toLowerCase().includes(q));
        if (!cmd) return text(`${project.name} has no command "${args.command}". Available: ${project.commands.map((c) => c.label).join(', ')}`, true);
        commandId = cmd.id;
      }
      const { run, error } = runner.request({ project, commandId, source: 'agent', reason: args.reason, client: ctx?.client?.name });
      onAgentActivity?.(project, run);
      if (error) return text({ error, current_run: run ? runReport(run, 10) : undefined }, true);
      if (args.wait) {
        const timeout = clamp(args.timeout_seconds, 5, 900, 300) * 1000;
        const done = await runner.waitFor(run.id, timeout);
        const report = runReport(done);
        return text({ ...report, message: statusLine(done) }, done.status === 'failed');
      }
      return text({ ...runReport(run, 0), message: statusLine(run) });
    },

    async wait_for_deploy(args) {
      const timeout = clamp(args.timeout_seconds, 1, 900, 120) * 1000;
      if (!runner.getRun(args.run_id)) return text(`Unknown run_id ${args.run_id}`, true);
      const run = await runner.waitFor(args.run_id, timeout);
      return text({ ...runReport(run), message: statusLine(run) }, run.status === 'failed');
    },

    async get_deploy_logs(args) {
      let run = args.run_id ? runner.getRun(args.run_id) : null;
      if (!run && args.project) {
        const project = resolveProject(store, args.project);
        if (project) run = runner.latestRunFor(project.id);
      }
      if (!run) return text('No deploy found. Pass a run_id or a project that has deployed before.', true);
      const lines = clamp(args.lines, 1, 6000, 200);
      return text({ ...runReport(run, 0), output: (run.log || []).slice(-lines).map(stripAnsi).join('\n') });
    },

    async cancel_deploy(args) {
      const ok = runner.cancel(args.run_id);
      return text(ok ? 'Cancel requested.' : 'That run is not active.', !ok);
    },

    async add_project(args) {
      try {
        const project = await onAddProject(args);
        return text({ message: `Added ${project.name}. It now has its own button in Ploink.`, project: { id: project.id, name: project.name, path: project.cwd, url: project.url, commands: project.commands } });
      } catch (err) {
        return text(String(err.message || err), true);
      }
    },

    async ai_usage() {
      const u = getUsage?.();
      if (!u) return text('Usage is not available.', true);
      const fmt = (p) => {
        if (!p.windows?.length) return `${p.name}: ${p.state === 'setup' ? 'not connected (connect it in Ploink settings)' : p.state === 'missing' ? 'not installed' : 'no data yet'}`;
        const ws = p.windows.map((w) => `${w.label} ${w.reset ? 'reset (new figure after next use)' : `${Math.round(w.used)}% used`}${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : ''}`);
        return `${p.name}: ${ws.join('; ')}${p.reached ? ' — LIMIT REACHED' : ''}${p.state === 'stale' ? ' (stale)' : ''}`;
      };
      return text([fmt(u.claude), fmt(u.codex)].join('\n'));
    },

    async recent_activity(args) {
      let items = store.activity;
      if (args.project) {
        const project = resolveProject(store, args.project);
        if (!project) return text(`No project matches "${args.project}".`, true);
        items = items.filter((e) => e.projectId === project.id);
      }
      if (args.failures_only) items = items.filter((e) => e.type === 'failed');
      items = items.slice(0, clamp(args.limit, 1, 200, 30));
      if (!items.length) return text('Nothing has happened yet.');
      const p2 = (n) => String(n).padStart(2, '0');
      const local = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const lines = items.map((e) => `${local(e.at)}  ${describeActivity(e)}${e.runId ? `  [run ${e.runId}]` : ''}`);
      return text(`Times are local (${tz}).\n` + lines.join('\n'));
    },

    async deploy_history(args) {
      const project = resolveProject(store, args.project);
      if (!project) return text(`No project matches "${args.project}".`, true);
      const limit = clamp(args.limit, 1, 25, 10);
      const runs = store.historyFor(project.id, limit, { deploysOnly: true }).map((r) => runReport(r, 0));
      return text({ project: project.name, runs });
    },
  };
  // run-neutral names for the same tools (callable, not listed, so the tool list stays short)
  tools.wait_for_run = tools.wait_for_deploy;
  tools.get_run_logs = tools.get_deploy_logs;
  tools.cancel_run = tools.cancel_deploy;

  async function handleMessage(msg, ctx = {}) {
    const isRequest = msg && typeof msg === 'object' && 'method' in msg && msg.id !== undefined && msg.id !== null;
    if (!isRequest) return null; // notifications and responses need no reply
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params?.protocolVersion;
          return reply({
            protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : LATEST,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'ploink', title: 'Ploink deploy cockpit', version: '0.3.2' },
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: TOOLS });
        case 'resources/list': return reply({ resources: [] });
        case 'resources/templates/list': return reply({ resourceTemplates: [] });
        case 'prompts/list': return reply({ prompts: [] });
        case 'tools/call': {
          const name = msg.params?.name;
          const fn = tools[name];
          if (!fn) return fail(-32602, `Unknown tool: ${name}`);
          return reply(await fn(msg.params?.arguments || {}, ctx));
        }
        default: return fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      return reply(text(`Ploink error: ${err.message}`, true));
    }
  }

  let server = null;
  let state = { running: false, port: null, error: null };

  function allowed(req, port) {
    const host = (req.headers.host || '').toLowerCase();
    if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return false; // DNS rebinding guard
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      try {
        const h = new URL(origin).hostname;
        if (!['localhost', '127.0.0.1', '[::1]'].includes(h)) return false;
      } catch { return false; }
    }
    return true;
  }

  // Every MCP request needs a client token (Settings > Agents), unless the user turned that off.
  // The token is what keeps other programs on this Mac from pressing buttons.
  function authorize(req) {
    if (store.settings.mcpAuth === 'off') return { ok: true, client: null };
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
    const client = m ? store.clientForToken(m[1]) : null;
    if (!client) return { ok: false, hadToken: !!m };
    store.touchClient(client);
    return { ok: true, client };
  }

  function onRequest(req, res, port) {
    const url = new URL(req.url, 'http://x');
    if (!allowed(req, port)) { res.writeHead(403).end('Forbidden'); return; }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, app: 'ploink' }));
      return;
    }
    if (url.pathname !== '/mcp') { res.writeHead(404).end('Not found'); return; }
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const auth = authorize(req);
    if (!auth.ok) {
      onUnauthorized?.({ hadToken: auth.hadToken, agent: String(req.headers['user-agent'] || '').slice(0, 80) });
      const message = auth.hadToken
        ? 'Ploink: this token is not valid (it may have been revoked). Copy a new setup line in Ploink > Settings > Agents.'
        : 'Ploink needs a client token. Open Ploink > Settings > Agents, create a token for this agent and use the setup line shown there.';
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }));
      return;
    }
    if (!String(req.headers['content-type'] || '').includes('application/json')) { res.writeHead(415).end('Expected application/json'); return; }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const batch = Array.isArray(payload);
      const ctx = { client: auth.client };
      const replies = (await Promise.all((batch ? payload : [payload]).map((m) => handleMessage(m, ctx)))).filter(Boolean);
      if (!replies.length) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(batch ? replies : replies[0]));
    });
  }

  return {
    get state() { return state; },
    start(port) {
      return new Promise((resolve) => {
        this.stop();
        const srv = http.createServer((req, res) => onRequest(req, res, port));
        srv.requestTimeout = 0; // wait_for_deploy can hold a request open for minutes
        srv.headersTimeout = 30_000;
        srv.on('error', (err) => {
          state = { running: false, port, error: err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message };
          resolve(state);
        });
        srv.listen(port, '127.0.0.1', () => {
          server = srv;
          state = { running: true, port, error: null, url: `http://127.0.0.1:${port}/mcp` };
          resolve(state);
        });
      });
    },
    stop() {
      if (server) { server.close(); server.closeAllConnections?.(); server = null; }
      state = { running: false, port: null, error: null };
    },
  };
}
