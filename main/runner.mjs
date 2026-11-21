// Runs deploy commands and action keys, streams their output, keeps history and handles agent approvals.
// A run is either a deploy (actionId null) or an action key: oneshot, check (reports a value) or service (start/stop).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { loadShellEnv, userShell } from './shellenv.mjs';
import { uid } from './store.mjs';
import { commandSteps, commandScript, commandDisplay, looksLikeDryRun, printedDryRun } from '../renderer/steps.js';

export { looksLikeDryRun, printedDryRun };

const MAX_LOG_LINES = 6000;
const HISTORY_LOG_LINES = 400;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 2 * 60 * 1000;
const VERIFY_TRIES = 4;
const VERIFY_GAP_MS = 5000;
export const TERMINAL = new Set(['success', 'failed', 'cancelled', 'denied', 'expired', 'stopped']);
const SUMMARY_KEYS = ['id', 'projectId', 'projectName', 'commandId', 'commandLabel', 'actionId', 'kind', 'cmd', 'cwd', 'source', 'client', 'reason', 'status', 'phase', 'value', 'url', 'verify', 'dryRun', 'createdAt', 'startedAt', 'endedAt', 'exitCode'];


// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');
// Keep colour codes (SGR) but drop cursor movement and other control sequences.
// eslint-disable-next-line no-control-regex
const keepSgr = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-ln-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
const LOCAL_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"]*)?/i;

/** The value a check shows: a regex capture (or match) when the action has one, else the last non-empty line. */
export function checkValue(lines, parse) {
  const text = lines.map(stripAnsi).join('\n');
  let value = '';
  if (parse) {
    try {
      const m = text.match(new RegExp(parse, 'm'));
      if (m) value = m[1] ?? m[0];
    } catch { /* bad regex: fall back to the last line */ }
  }
  if (!value) value = [...lines].reverse().map((l) => stripAnsi(l).trim()).find(Boolean) || '';
  // long decimals read badly on a 20-character readout: 0.213456 -> 0.21
  return value.replace(/(\d+\.\d{2})\d+/g, '$1').trim().slice(0, 48);
}

export class Runner extends EventEmitter {
  constructor(store, { verifyGapMs = VERIFY_GAP_MS } = {}) {
    super();
    this.store = store;
    this.verifyGapMs = verifyGapMs;
    this.runs = new Map(); // live + recently finished runs, with full logs
  }

  /** The active run of one button: the deploy (actionId null) or an action key. */
  activeRunFor(projectId, actionId = null) {
    for (const run of this.runs.values()) {
      if (run.projectId === projectId && (run.actionId || null) === actionId && !TERMINAL.has(run.status)) return run;
    }
    return null;
  }

  activeRunsFor(projectId) {
    return [...this.runs.values()].filter((r) => r.projectId === projectId && !TERMINAL.has(r.status));
  }

  /** Latest deploy of a project (action runs never count). */
  latestRunFor(projectId) {
    let best = null;
    for (const run of this.runs.values()) {
      if (run.projectId === projectId && !run.actionId && (!best || run.createdAt > best.createdAt)) best = run;
    }
    return best || this.store.historyFor(projectId, 1, { deploysOnly: true })[0] || null;
  }

  latestActionRun(projectId, actionId) {
    let best = null;
    for (const run of this.runs.values()) {
      if (run.projectId === projectId && run.actionId === actionId && (!best || run.createdAt > best.createdAt)) best = run;
    }
    return best || this.store.history.find((r) => r.projectId === projectId && r.actionId === actionId) || null;
  }

  getRun(runId) {
    return this.runs.get(runId) || this.store.history.find((r) => r.id === runId) || null;
  }

  // plain, structured-clone-safe view of a run (no timers, no child process)
  summary(run) {
    if (!run) return null;
    const out = {};
    for (const key of SUMMARY_KEYS) out[key] = run[key] ?? null;
    out.lastLine = lastMeaningful(run.log);
    return out;
  }

  /**
   * Request a deploy (commandId) or an action key (actionId). Returns { run } or { error, run? }.
   * source: 'user' | 'agent' | 'tray'. client: the agent's name, from its MCP token.
   */
  request({ project, commandId, actionId, source = 'user', reason = '', client = '' }) {
    let command = null;
    let action = null;
    if (actionId) {
      action = (project.actions || []).find((a) => a.id === actionId);
      if (!action) return { error: 'That action key no longer exists.' };
    } else {
      command = project.commands.find((c) => c.id === commandId) ||
        project.commands.find((c) => c.id === project.activeCommandId) || project.commands[0];
      if (!command) return { error: 'This project has no deploy command yet. Add one in its settings.' };
    }
    const button = action || command;
    if (!project.cwd || !fs.existsSync(project.cwd)) return { error: `Project folder not found: ${project.cwd || '(none)'}` };
    if (source === 'agent' && action && !action.agents) {
      return { error: `Agents may not press "${action.label}" on ${project.name}. The user can allow it in the bay settings.` };
    }
    if (source !== 'agent' && button.trusted === false) {
      return { error: `An agent added "${button.label}". Review the command in the bay settings before it runs.`, review: true };
    }
    const busy = this.activeRunFor(project.id, action ? action.id : null);
    if (busy) {
      const what = action ? `${action.label} is already ${action.kind === 'service' ? 'running' : 'busy'}` : `${project.name} is already deploying`;
      return { error: busy.status === 'awaiting_approval' ? `${project.name}: a request for ${button.label} is waiting for approval.` : `${what}.`, run: busy };
    }

    const settings = this.store.settings;
    // agents always ask for: commands an agent added (nobody has looked at them), hold-to-run keys,
    // projects that ask for approval, and everything when the user picked "Ask me first"
    const needsApproval = source === 'agent' && (
      button.trusted === false || settings.agentApproval === 'ask' || (action ? action.hold : project.requireApproval)
    );
    const verify = !action ? (project.actions || []).find((a) => a.kind === 'check' && a.afterDeploy && a.trusted !== false) : null;
    const run = {
      id: uid('r_'),
      projectId: project.id,
      projectName: project.name,
      commandId: command ? command.id : null,
      commandLabel: button.label,
      actionId: action ? action.id : null,
      kind: action ? action.kind : 'deploy',
      cmd: commandDisplay(button.cmd), // one line, for logs, readouts and agents
      script: commandScript(button.cmd), // what the shell runs: one step as typed, or steps joined with &&
      stepList: commandSteps(button.cmd),
      cwd: project.cwd,
      siteUrl: project.url || '',
      parse: action?.parse || '',
      verifyAction: verify ? { label: verify.label, cmd: commandScript(verify.cmd), parse: verify.parse } : null,
      dryRun: !action && looksLikeDryRun(button.cmd, button.label),
      // the command that really ships, named in the "nothing was deployed" note
      shipLabel: !action ? (project.commands.find((c) => c.id !== command.id && !looksLikeDryRun(c.cmd, c.label))?.label || '') : '',
      untrusted: button.trusted === false,
      source,
      client: String(client || '').slice(0, 40),
      reason: String(reason || '').slice(0, 200),
      status: needsApproval ? 'awaiting_approval' : 'starting',
      phase: null,
      value: null,
      url: null,
      verify: null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      log: [],
      child: null,
    };
    this.runs.set(run.id, run);
    this.pruneLive();
    if (needsApproval) {
      run.approvalTimer = setTimeout(() => this.finish(run, 'expired', null, 'Approval request expired.'), APPROVAL_TTL_MS);
      this.emitUpdate(run);
      this.emit('approval', run);
    } else {
      this.emitUpdate(run);
      this.spawn(run);
    }
    return { run };
  }

  approve(runId) {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'awaiting_approval') return false;
    clearTimeout(run.approvalTimer);
    run.status = 'starting';
    if (run.untrusted) this.emit('trusted', run); // approving an agent-added command is the human review
    this.emitUpdate(run);
    this.spawn(run);
    return true;
  }

  deny(runId) {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'awaiting_approval') return false;
    clearTimeout(run.approvalTimer);
    this.finish(run, 'denied', null, 'Request was denied.');
    return true;
  }

  /** Stop a run. For a service this is the normal "off" switch. */
  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run || TERMINAL.has(run.status)) return false;
    if (run.status === 'awaiting_approval') return this.deny(runId);
    run.cancelRequested = true;
    clearTimeout(run.verifyTimer);
    if (run.phase === 'verify' && !run.child) { this.finish(run, 'cancelled', null, 'Cancelled.'); return true; }
    this.killTree(run, 'SIGTERM');
    setTimeout(() => !TERMINAL.has(run.status) && this.killTree(run, 'SIGKILL'), 4000);
    return true;
  }

  killTree(run, signal) {
    const pid = run.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try { run.child.kill(signal); } catch { /* already gone */ }
    }
  }

  async env(run) {
    const env = await loadShellEnv();
    return {
      ...env,
      FORCE_COLOR: '1',
      CLICOLOR_FORCE: '1',
      PLOINK: '1',
      PLOINK_PROJECT: run.projectName,
      PLOINK_URL: run.siteUrl || '',
      PLOINK_BUTTON: run.commandLabel,
      PLOINK_SOURCE: run.source,
    };
  }

  startChild(run, cmd, env) {
    return spawn(userShell, ['-lc', cmd], { cwd: run.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  }

  async spawn(run) {
    const env = await this.env(run);
    if (run.status !== 'starting') return;
    if (run.cancelRequested) return this.finish(run, 'cancelled', null, 'Cancelled before it started.');
    run.status = 'running';
    run.startedAt = Date.now();
    // a multi-step command lists its steps; a one-step command shows the line it runs
    const steps = run.stepList?.length > 1 ? run.stepList.map((s, i) => `\x1b[2m${i + 1}. ${s}\x1b[0m`) : [`\x1b[2m$ ${run.cmd}\x1b[0m`];
    if (run.stepList?.length > 1) steps.push('\x1b[2m   (each step runs only if the one before it succeeded)\x1b[0m');
    this.pushLines(run, [...steps, `\x1b[2m  in ${run.cwd}\x1b[0m`, '']);
    run.outStart = run.log.length;
    this.emitUpdate(run);

    let child;
    try {
      child = this.startChild(run, run.script || run.cmd, env);
    } catch (err) {
      return this.finish(run, 'failed', null, `Could not start: ${err.message}`);
    }
    run.child = child;

    // services run until you stop them; checks are quick; deploys and one-shots get the deploy timeout
    const timeoutMs = run.kind === 'service' ? 0 : run.kind === 'check' ? CHECK_TIMEOUT_MS : (Number(this.store.settings.deployTimeoutMin) || 30) * 60 * 1000;
    if (timeoutMs) {
      run.timeout = setTimeout(() => {
        this.pushLines(run, [`\x1b[31mTimed out after ${Math.round(timeoutMs / 60000) || 1} min. Stopping.\x1b[0m`]);
        run.timedOut = true;
        this.killTree(run, 'SIGTERM');
        setTimeout(() => this.killTree(run, 'SIGKILL'), 4000);
      }, timeoutMs);
    }

    const { out, err } = this.attach(run, child);
    child.on('close', (code, signal) => {
      out.flush();
      err.flush();
      clearTimeout(run.timeout);
      run.child = null;
      const exit = code ?? (signal ? 128 : 1);
      if (run.kind === 'service') {
        if (run.cancelRequested || code === 0) return this.finish(run, 'stopped', code, run.cancelRequested ? 'Stopped.' : 'The process ended.');
        return this.finish(run, 'failed', exit, null);
      }
      if (run.cancelRequested) return this.finish(run, 'cancelled', code, 'Cancelled.');
      if (run.timedOut) return this.finish(run, 'failed', code ?? 124, null);
      if (run.kind === 'check') run.value = checkValue(run.log.slice(run.outStart), run.parse);
      if (code === 0 && run.kind === 'deploy' && !run.dryRun && printedDryRun(run.log.slice(run.outStart))) run.dryRun = true;
      if (code === 0 && run.dryRun) {
        const next = run.shipLabel ? ` To ship, switch the button to "${run.shipLabel}".` : '';
        return this.finish(run, 'success', 0, `Dry run: it passed, but nothing was deployed.${next}`);
      }
      if (code === 0 && run.verifyAction) return this.verify(run, env);
      this.finish(run, code === 0 ? 'success' : 'failed', exit, null);
    });
  }

  attach(run, child) {
    const makeReader = () => {
      let pending = '';
      const read = (chunk) => {
        pending += chunk.toString('utf8');
        const parts = pending.split('\n');
        pending = parts.pop();
        if (parts.length) this.pushLines(run, parts);
        // flush long partial lines (progress output without newlines)
        if (pending.length > 4000) { this.pushLines(run, [pending]); pending = ''; }
      };
      read.flush = () => { if (pending) this.pushLines(run, [pending]); pending = ''; };
      return read;
    };
    const out = makeReader();
    const err = makeReader();
    child.stdout.on('data', out);
    child.stderr.on('data', err);
    child.on('error', (e) => this.pushLines(run, [`\x1b[31m${e.message}\x1b[0m`]));
    return { out, err };
  }

  // After a successful deploy: run the project's site check a few times (sites take a moment
  // to come up). The deploy only counts as shipped when the check passes.
  verify(run, env) {
    const check = run.verifyAction;
    run.phase = 'verify';
    let attempt = 0;
    const tryOnce = () => {
      if (run.cancelRequested) return this.finish(run, 'cancelled', null, 'Cancelled.');
      attempt++;
      this.pushLines(run, ['', `\x1b[2m── ${check.label} check${attempt > 1 ? ` (try ${attempt} of ${VERIFY_TRIES})` : ''} ──\x1b[0m`, `\x1b[2m$ ${check.cmd}\x1b[0m`]);
      this.emitUpdate(run);
      const from = run.log.length;
      let child;
      try { child = this.startChild(run, check.cmd, env); } catch (err) { return this.finish(run, 'failed', null, `Could not start the check: ${err.message}`); }
      run.child = child;
      const guard = setTimeout(() => this.killTree(run, 'SIGKILL'), 60_000);
      const { out, err } = this.attach(run, child);
      child.on('close', (code) => {
        out.flush();
        err.flush();
        clearTimeout(guard);
        run.child = null;
        if (run.cancelRequested) return this.finish(run, 'cancelled', null, 'Cancelled.');
        const value = checkValue(run.log.slice(from), check.parse);
        if (code === 0) {
          run.verify = { ok: true, label: check.label, value };
          return this.finish(run, 'success', 0, null);
        }
        if (attempt < VERIFY_TRIES) {
          this.pushLines(run, [`\x1b[33m${check.label} check did not pass yet (${value || `exit ${code}`}). Trying again in ${Math.round(this.verifyGapMs / 1000)}s.\x1b[0m`]);
          run.verifyTimer = setTimeout(tryOnce, this.verifyGapMs);
          return;
        }
        run.verify = { ok: false, label: check.label, value };
        this.finish(run, 'failed', code ?? 1, `Deployed, but the ${check.label} check failed${value ? `: ${value}` : ''}.`);
      });
    };
    tryOnce();
  }

  pushLines(run, lines) {
    const clean = [];
    for (let line of lines) {
      // carriage returns = progress bar redraws; keep only the final frame
      if (line.includes('\r')) {
        const frames = line.split('\r').filter((f) => f.trim());
        line = frames[frames.length - 1] || '';
      }
      line = keepSgr(line);
      clean.push(line);
    }
    if (!clean.length) return;
    run.log.push(...clean);
    if (run.log.length > MAX_LOG_LINES) {
      const drop = run.log.length - MAX_LOG_LINES;
      run.log.splice(0, drop);
      if (run.outStart) run.outStart = Math.max(0, run.outStart - drop);
    }
    // a dev server announces where it listens: show it on the key
    if (run.kind === 'service' && !run.url) {
      for (const line of clean) {
        const m = stripAnsi(line).match(LOCAL_URL_RE);
        if (m) { run.url = m[0].replace(/0\.0\.0\.0|\[::1?\]/, 'localhost').replace(/[).,]+$/, ''); this.emitUpdate(run); break; }
      }
    }
    this.queueLog(run, clean);
  }

  queueLog(run, lines) {
    run._pendingLog = (run._pendingLog || []).concat(lines);
    if (run._logTimer) return;
    run._logTimer = setTimeout(() => {
      const batch = run._pendingLog;
      run._pendingLog = [];
      run._logTimer = null;
      this.emit('log', { runId: run.id, projectId: run.projectId, actionId: run.actionId, lines: batch, lastLine: lastMeaningful(run.log) });
    }, 70);
  }

  finish(run, status, exitCode, message) {
    if (TERMINAL.has(run.status)) return;
    if (message) this.pushLines(run, ['', `\x1b[2m${message}\x1b[0m`]);
    run.status = status;
    run.exitCode = exitCode;
    run.endedAt = Date.now();
    run.child = null;
    if (run.phase === 'verify') run.phase = null;
    clearTimeout(run.approvalTimer);
    clearTimeout(run.timeout);
    clearTimeout(run.verifyTimer);
    const { log, child, approvalTimer, timeout, verifyTimer, _pendingLog, _logTimer, outStart, shipLabel, ...rest } = run;
    this.store.addHistory({ ...rest, log: log.slice(-HISTORY_LOG_LINES) });
    this.emitUpdate(run);
    this.emit('finished', run);
  }

  emitUpdate(run) {
    this.emit('update', this.summary(run));
  }

  pruneLive() {
    // keep live map bounded: drop old finished runs beyond 80
    const finished = [...this.runs.values()].filter((r) => TERMINAL.has(r.status)).sort((a, b) => b.createdAt - a.createdAt);
    for (const r of finished.slice(80)) this.runs.delete(r.id);
  }

  waitFor(runId, ms) {
    const run = this.runs.get(runId);
    if (!run || TERMINAL.has(run.status)) return Promise.resolve(this.getRun(runId));
    return new Promise((resolve) => {
      const done = (r) => {
        if (r.id !== runId) return;
        cleanup();
        resolve(this.getRun(runId));
      };
      const timer = setTimeout(() => { cleanup(); resolve(this.getRun(runId)); }, ms);
      const cleanup = () => { clearTimeout(timer); this.off('finished', done); };
      this.on('finished', done);
    });
  }

  stopAll() {
    for (const run of this.runs.values()) if (run.child) this.killTree(run, 'SIGTERM');
  }
}

function lastMeaningful(log) {
  if (!log) return '';
  for (let i = log.length - 1; i >= 0 && i > log.length - 30; i--) {
    const s = stripAnsi(log[i]).trim();
    if (s) return s.slice(0, 200);
  }
  return '';
}
