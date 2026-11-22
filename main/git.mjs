// The git branch each project is on, read straight from .git/HEAD: no git binary, no
// spawn, cheap enough to poll. Works from a subfolder of a repo, in worktrees and
// submodules (where .git is a file pointing at the real git dir), and on a detached HEAD.
import fs from 'node:fs';
import path from 'node:path';

// { branch: 'main' } | { branch: null, detached: true, sha: 'a1b2c3d' } | null (not a repo)
export function gitHead(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch { /* keep walking up */ }
    if (st) {
      try {
        let gitDir = dotGit;
        if (st.isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
          if (!m) return null;
          gitDir = path.resolve(dir, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return { branch: ref[1] };
        if (/^[0-9a-f]{7,64}$/i.test(head)) return { branch: null, detached: true, sha: head.slice(0, 7) };
        return null;
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// one line for logs and agents: "main", or "detached at a1b2c3d"
export function gitLabel(head) {
  if (!head) return null;
  return head.branch || (head.detached ? `detached at ${head.sha}` : null);
}

// Keeps { [projectId]: head } fresh for the windows. Polls every few seconds (a handful
// of tiny file reads) and calls onChange only when a branch actually changed.
export function createGitWatch({ projects, onChange, intervalMs = 2500 }) {
  let state = {};
  let timer = null;
  const sig = (s) => JSON.stringify(s);

  function refresh() {
    const next = {};
    for (const p of projects()) next[p.id] = gitHead(p.cwd);
    if (sig(next) !== sig(state)) {
      state = next;
      onChange?.(state);
    }
    return state;
  }

  return {
    get state() { return state; },
    refresh,
    start() {
      refresh();
      clearInterval(timer);
      timer = setInterval(refresh, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
