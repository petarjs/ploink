# Security

Ploink runs shell commands on your Mac and lets coding agents ask it to run them. A
security bug here can matter, so thank you for looking.

## Reporting a problem

Email **hey@ploink.dev** with the subject "Security". Please include what you found,
how to reproduce it, and which version you used (Ploink > About). Don't open a public
issue for anything that could let someone run commands they shouldn't.

You'll get a reply within a few days. Fixes go out as a new release, and you are
credited in the release notes unless you'd rather not be.

## What Ploink protects against

- **Web pages.** The MCP server listens on 127.0.0.1 only. It rejects requests whose
  `Host` header is not localhost and requests with a non-local `Origin` (DNS rebinding
  and cross-site requests).
- **Other programs on the Mac.** Every agent request needs a per-client token, compared
  in constant time. Tokens are created and revoked in Settings > Agents (MCP).
- **Agents running anything they like.** Agents can only press buttons you set up.
  There is no tool that runs an arbitrary command. Commands an agent adds stay
  untrusted until you review them, and you can require approval (a glowing button you
  hold) for any project or for all agent deploys.
- **Reading your settings.** `ploink-config.json` holds tokens and commands and is
  written readable by your user only (mode 600).
- **Credentials of other tools.** The AI usage gauges use the official `claude` and
  `codex` command line tools. Ploink never reads, stores or sends passwords, OAuth
  tokens or cookies.

## What it does not protect against

- A trusted command such as `npm run deploy` runs whatever the script says at that
  moment. An agent or a person who can edit the project can change what it does.
- Anything already running as your user can read your files, including Ploink's
  config. Ploink is not a sandbox.
- Unsigned beta builds: macOS can't verify who built them. Build from source or wait
  for the signed release if that matters to you.
