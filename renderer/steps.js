// Deploy commands can be several steps, one per line. Shared by the main process (main/runner.mjs,
// main/mcp.mjs) and the UI, so everyone agrees on what runs.
//
//   - Blank lines are skipped. Lines starting with # are comments.
//   - A line ending in \ continues on the next line, as in a shell.
//   - Steps run in order in the login shell and stop at the first one that fails.
//   - A command with one step runs exactly as typed, so one-line commands that already
//     contain && (or anything else) behave as they always did. Nothing is split on &&.

/** The steps of a command, in order. */
export function commandSteps(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const steps = [];
  let pending = null; // a step continued with a trailing backslash
  for (const raw of lines) {
    if (pending === null && raw.trim().startsWith('#')) continue; // a comment never continues
    const line = pending === null ? raw : pending + raw;
    const end = line.replace(/[ \t]+$/, '');
    const slashes = end.length - end.replace(/\\+$/, '').length;
    if (slashes % 2 === 1) { pending = end.slice(0, -1); continue; } // odd trailing backslashes: continuation
    pending = null;
    const step = line.trim();
    if (step) steps.push(step);
  }
  if (pending !== null && pending.trim()) steps.push(pending.trim()); // a backslash on the last line
  return steps;
}

/**
 * The shell text that runs. One step: exactly as typed. Several: each step in its own group, joined
 * with &&, so the run stops at the first failure. Each group ends on its own line, so a trailing
 * "# comment" inside a step can't swallow the && after it.
 */
export function commandScript(text) {
  const steps = commandSteps(text);
  if (steps.length > 1) return steps.map((s) => `{ ${s}\n}`).join(' && ');
  return steps[0] ?? String(text ?? '').trim();
}

/** How a command reads in one line: steps joined with " && ". */
export function commandDisplay(text) {
  const steps = commandSteps(text);
  return steps.length > 1 ? steps.join(' && ') : steps[0] ?? String(text ?? '').trim();
}

/** A short form for narrow places: the first step, plus "+N" for the rest. */
export function commandSummary(text) {
  const steps = commandSteps(text);
  if (steps.length > 1) return `${steps[0]} +${steps.length - 1}`;
  return steps[0] ?? String(text ?? '').trim();
}

// A dry run exits 0 but deploys nothing, so it must never read as "shipped". It is known by its
// label or command ("dry run", --dry-run, deploy:dry-run), or by what it prints when it ends.
const DRY_RUN_RE = /\bdry[-_ ]?run\b|--dryrun\b/i;
const DRY_RUN_OUTPUT_RE = /--dry-run: exiting now|\bdry[- ]run (?:complete|completed|finished|succeeded|done|only)\b|\bthis (?:was|is) a dry[- ]run\b/i;

/** True when a command (or its label) is a dry run. */
export function looksLikeDryRun(cmd, label = '') {
  return DRY_RUN_RE.test(String(label ?? '')) || DRY_RUN_RE.test(commandDisplay(cmd));
}

/** True when a command's output says it was a dry run. Lines may carry colour codes. */
export function printedDryRun(lines) {
  // eslint-disable-next-line no-control-regex
  return lines.some((l) => DRY_RUN_OUTPUT_RE.test(String(l).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')));
}

// Which environment a deploy command ships to, read from what it runs. Explicit flags win
// (--env staging, --stage prod, --mode production, --target preview, --prod), then the
// platform default (vercel and netlify deploy a preview unless told --prod), then a script
// name like deploy:staging, then the button's label. Returns null when nothing says, so
// the UI never guesses.
const ENV_WORDS = {
  production: ['production', 'prod', 'prd', 'live'],
  staging: ['staging', 'stage', 'stg'],
  preview: ['preview', 'draft'],
  development: ['development', 'dev'],
};
const ENV_OTHER = ['qa', 'uat', 'sandbox', 'canary', 'beta', 'demo'];
const ENV_SHORT = { production: 'PROD', staging: 'STAGING', preview: 'PREVIEW', development: 'DEV' };
const INSTALL_RE = /^(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b/;
const PLATFORM_RE = /^(?:(?:npx|bunx)\s+|(?:pnpm|yarn)\s+(?:exec\s+|dlx\s+)?)?(vercel|netlify|ntl)(?:\s+(\S+))?/;

function knownEnv(word) {
  const w = String(word || '').toLowerCase();
  for (const [name, words] of Object.entries(ENV_WORDS)) if (words.includes(w)) return name;
  return ENV_OTHER.includes(w) ? w : null;
}

function target(env, from) {
  return env ? { env, short: ENV_SHORT[env] || env.toUpperCase().slice(0, 10), from } : null;
}

// the simple commands inside a button: steps, then && / || / ; / | chains, comments dropped
function simpleCommands(cmd) {
  return commandSteps(cmd)
    .map((s) => s.replace(/(^|\s)#.*$/, '$1'))
    .flatMap((s) => s.split(/&&|\|\||;|\|/))
    .map((s) => s.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '')) // drop leading VAR=value
    .filter(Boolean);
}

export function deployTarget(cmd, label = '') {
  const parts = simpleCommands(cmd);
  for (const part of parts) {
    if (INSTALL_RE.test(part)) continue;
    const any = /(?:^|\s)--(?:env|environment|stage)(?:=|\s+)["']?([\w.-]+)/i.exec(part);
    if (any) return target(knownEnv(any[1]) || any[1].toLowerCase().slice(0, 16), 'command');
    const known = /(?:^|\s)--(?:mode|target|context)(?:=|\s+)["']?([\w.-]+)/i.exec(part);
    if (known && knownEnv(known[1])) return target(knownEnv(known[1]), 'command');
    if (/(?:^|\s)--prod(?:uction)?(?:\s|$)/i.test(part)) return target('production', 'command');
  }
  for (const part of parts) {
    const m = PLATFORM_RE.exec(part);
    if (!m) continue;
    const sub = m[2] || '';
    const deploys = m[1] === 'vercel' ? !sub || sub === 'deploy' || sub.startsWith('-') : sub === 'deploy';
    if (deploys) return target('preview', 'command');
  }
  for (const part of parts) {
    const m = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)|^make\s+([\w:.-]+)/.exec(part);
    const script = m && (m[1] || m[2]);
    if (!script) continue;
    const env = script.split(/[:._-]/).slice(1).map(knownEnv).find(Boolean);
    if (env) return target(env, 'command');
  }
  const fromLabel = String(label || '').split(/[^a-z0-9]+/i).map(knownEnv).find(Boolean);
  return target(fromLabel, 'label');
}
