# Contributing

Thanks for wanting to help. Ploink is a small, opinionated app, so a short read first
saves us both time.

## What Ploink is (and isn't)

Ploink is a **deploy console**: one tactile launch button per project, a launch bar,
a few action keys per project, a flight log, and an MCP server so agents can press
the buttons with your permission.

It is not trying to be a general launcher, a Stream Deck replacement or a CI system.
Ideas that keep the focus on "ship this project, safely, with a satisfying press" are
the most likely to land. If you are not sure, open an issue before you write code.

## Running it

```bash
npm install
npm start          # the Electron app
npm run preview    # the UI in a browser with fake projects (no Electron)
npm test           # node --test, no extra dependencies
```

Use a separate data folder while you hack, so your real projects stay untouched:

```bash
PLOINK_USER_DATA=/tmp/ploink-dev npm start
```

## Code

- Plain JavaScript (ES modules), no build step and no framework. The renderer is
  vanilla DOM (`renderer/`), the main process is Node (`main/`).
- Keep dependencies at zero for runtime code. Electron and electron-builder are the
  only dev dependencies.
- Sounds are synthesized in `renderer/audio.js`, effects in `renderer/fx.js`. Please
  keep it that way: no sample files.
- Anything that runs commands, opens a port or touches other tools' settings needs a
  test in `test/` and a line in `SECURITY.md` if it changes the security model.

## Pull requests

- One change per pull request, with a short description of what and why.
- Screenshots or a short screen recording for anything visible.
- `npm test` passes.

## Deploy scripts that don't work

Every deploy script is different. If a project does not deploy from Ploink but does in
your terminal, open an issue with the command, the error line from the log drawer,
your shell (`echo $SHELL`), and how you installed Node (nvm, Homebrew, ...).

## Pro

Ploink is open core. The app in this repository is and stays free (MIT). Paid Pro
features live in a separate package and are not developed here.
