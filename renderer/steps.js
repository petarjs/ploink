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
