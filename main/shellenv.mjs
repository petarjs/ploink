// Apps launched from Finder get a bare PATH. Ask the user's login shell for its
// real environment once (nvm, Homebrew, pnpm, etc.) and reuse it for every deploy.
import { execFile } from 'node:child_process';

const MARK = '__PLOINK_ENV__';
export const userShell = process.env.SHELL || '/bin/zsh';

function capture(args) {
  return new Promise((resolve) => {
    execFile(
      userShell,
      [...args, `printf '${MARK}'; /usr/bin/env -0; printf '${MARK}'`],
      {
        timeout: 8000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', ZSH_TMUX_AUTOSTART: 'false' },
      },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        const parts = String(stdout).split(MARK);
        if (parts.length < 3) return resolve(null);
        const env = {};
        for (const entry of parts[1].split('\0')) {
          const i = entry.indexOf('=');
          if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
        }
        resolve(Object.keys(env).length ? env : null);
      },
    );
  });
}

let cached = null;

export function loadShellEnv() {
  if (!cached) {
    cached = (async () => {
      const env = (await capture(['-ilc'])) || (await capture(['-lc'])) || {};
      const base = { ...process.env, ...env };
      for (const key of Object.keys(base)) {
        if (key.startsWith('ELECTRON_') || key.startsWith('npm_') || key === 'INIT_CWD' || key === 'CHROME_DESKTOP') {
          delete base[key];
        }
      }
      base.PATH = base.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
      return base;
    })();
  }
  return cached;
}
