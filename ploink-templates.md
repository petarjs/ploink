# Ploink action templates

These are ready-made actions for the small keys under each project's big deploy button. They cover commands that developers, designers and DevOps people run every week, so nobody has to start from an empty editor. Copy one, change the script name or port if your project differs, and press.

## How to read the tables

- **Kind.** `oneshot` runs once and goes green or red by exit code. `check` runs once and shows a short value on the readout. By default the value is the last non-empty line of output. `service` keeps running until you stop it (click the key again), and the key shows the port of the first `http://localhost:PORT` or `http://127.0.0.1:PORT` it prints.
- **Hold.** "yes" means the action can lose data, touch production or force something, so turn on "hold to run": a click does nothing, you hold the key, and agents always need your approval. "no" means a click is enough.
- **Agents.** The suggested "Agents may press" setting. Read-only checks are safe. Anything that writes outside the project folder, spends money, opens a public tunnel or starts another agent is "no".
- **Environment.** Every run gets `PLOINK=1`, `PLOINK_URL` (the project's website, may be empty), `PLOINK_PROJECT`, `PLOINK_BUTTON` (the key's label) and `PLOINK_SOURCE` (`user`, `tray` or `agent`). It runs in the project folder with your login shell's `PATH`. stdin is closed, so commands must not wait for input.
- **Package manager.** Commands use `npm`. Swap in `pnpm`, `yarn` or `bun` to match your lockfile.
- **`.env` files are not loaded.** For commands that need `DATABASE_URL` or similar, put `set -a; . ./.env; set +a;` in front.
- **Pipes.** In the tables, `\|` stands for a plain pipe `|`.

## Dev servers and watchers

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| dev | service | `npm run dev` | `localhost:3000` or `5173` while it runs | no | yes |
| storybook | service | `npm run storybook` | `localhost:6006` | no | yes |
| vitest | service | `npx vitest --watch` | Runs tests on every save. Failures appear in the log. `--watch` is needed because Ploink runs without a terminal. | no | no |
| preview | service | `npm run build && npm run preview` | The production build served locally, usually `localhost:4173` | no | yes |
| django | service | `python manage.py runserver` | `127.0.0.1:8000` | no | yes |
| uvicorn | service | `uvicorn main:app --reload` | FastAPI on `127.0.0.1:8000` | no | yes |

## Git and GitHub

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| pull | oneshot | `git pull --ff-only` | Fails safely instead of creating a merge commit | no | yes |
| fetch | oneshot | `git fetch --all --prune` | Updates remote branches and drops deleted ones | no | yes |
| sync | check | `git fetch -q && git rev-list --left-right --count 'HEAD...@{u}' \| awk '{print "↑" $1 " ↓" $2}'` | `↑2 ↓5`: commits ahead of and behind the remote | no | yes |
| changes | check | `echo "$(git status --porcelain \| wc -l \| tr -d ' ') changed"` | `7 changed`: uncommitted files | no | yes |
| push | oneshot | `git push` | Sends your commits to the remote | no | no |
| new PR | check | `gh pr create --fill` | The PR URL on the readout. Title and body come from your commits. | no | no |
| prune | oneshot | `git branch --merged \| grep -vE '^\*\|^[[:space:]]*(main\|master\|develop)$' \| xargs git branch -d` | Deletes local branches that are already merged. Keeps main, master and develop. | yes | no |
| ci | check | `s=$(gh run list --branch "$(git branch --show-current)" --limit 1 --json workflowName,status,conclusion --jq '.[0] \| "\(.workflowName): \(if .conclusion == "" then .status else .conclusion end)"'); echo "$s"; [ "${s%failure}" = "$s" ]` | `CI: success` or `CI: in_progress`. Goes red on `failure`. | no | yes |
| PRs | check | `echo "$(gh pr list --json number --jq length) open PRs"` | Open pull requests in this repo | no | yes |
| reviews | check | `echo "$(gh search prs --review-requested=@me --state=open --json number --jq length) to review"` | PRs waiting for your review, across GitHub | no | yes |

## Health and monitoring

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| health | check | `curl -fsS -o /dev/null -w '%{http_code} %{time_total}s' "$PLOINK_URL"` | `200 0.153s`. Red on 4xx, 5xx or no answer. | no | yes |
| api | check | `curl -fsS "$PLOINK_URL/api/health"` | The health endpoint's body, for example `{"ok":true}`. Change the path to match yours. | no | yes |
| ssl days | check | `h=$(echo "$PLOINK_URL" \| sed -E 's#^[a-z]+://##; s#[/:].*##'); e=$(echo \| openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null \| openssl x509 -noout -enddate \| cut -d= -f2); d=$(( ($(date -j -f '%b %e %T %Y %Z' "$e" +%s) - $(date +%s)) / 86400 )); echo "$d days"; [ "$d" -ge 14 ]` | `34 days` until the certificate expires. Red under 14. | no | yes |
| dns | check | `dig +short "$(echo "$PLOINK_URL" \| sed -E 's#^[a-z]+://##; s#[/:].*##')" \| tail -1` | The IP the domain points to. Handy after DNS changes. | no | yes |

## Builds, tests and quality

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| test | oneshot | `npm test` | Pass or fail, full output in the log | no | yes |
| lint | oneshot | `npm run lint` | | no | yes |
| types | oneshot | `npx tsc --noEmit` | TypeScript errors without building | no | yes |
| build | oneshot | `npm run build` | | no | yes |
| format | oneshot | `npx prettier --write .` | Rewrites files in place | no | yes |
| e2e | oneshot | `npx playwright test` | Browser tests. The HTML report link appears in the log. | no | yes |
| install | oneshot | `npm ci` | A clean install from the lockfile | no | yes |
| outdated | check | `echo "$(npm outdated --json 2>/dev/null \| jq length) outdated"` | `12 outdated`. `jq` is built into macOS 15 and later. | no | yes |
| audit | check | `npm audit --json 2>/dev/null \| jq -r '.metadata.vulnerabilities \| "\(.critical) critical, \(.high) high"'` | `0 critical, 2 high` | no | yes |
| dist size | check | `npm run build >/dev/null && du -sh dist \| cut -f1` | `412K`. Use `.next` or `build` if your framework writes there. | no | yes |

## Databases

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| migrate | oneshot | `npx prisma migrate deploy` | Applies pending migrations to whatever `DATABASE_URL` points at. Drizzle: `npx drizzle-kit migrate`. | yes | no |
| studio | service | `npx prisma studio` | `localhost:5555`, a table browser | no | no |
| seed | oneshot | `npx prisma db seed` | Fills the dev database with sample data | no | yes |
| db reset | oneshot | `npx prisma migrate reset --force` | Drops and recreates the database, then seeds it | yes | no |
| backup | check | `mkdir -p backups && f="backups/$(date +%Y%m%d-%H%M).dump" && pg_dump "$DATABASE_URL" -Fc -f "$f" && echo "$f"` | The new file's name. Add `backups/` to `.gitignore`. | no | no |
| db size | check | `psql "$DATABASE_URL" -Atc "select pg_size_pretty(pg_database_size(current_database()))"` | `48 MB` | no | yes |
| redis | check | `redis-cli ping` | `PONG`, or red when Redis is down | no | yes |
| flush | oneshot | `redis-cli flushall` | Empties every Redis database. Dev only. | yes | no |

## Containers

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| compose | service | `docker compose up` | Running while the stack is up. Stopping the key stops the containers. | no | yes |
| down | oneshot | `docker compose down` | Removes the stack's containers and network. Use it if a stop leaves containers behind. | no | yes |
| running | check | `echo "$(docker ps -q \| wc -l \| tr -d ' ') running"` | `3 running` containers | no | yes |
| prune | oneshot | `docker system prune -f` | Deletes stopped containers, unused networks and dangling images | yes | no |

## Cloud and deploy platforms

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| vc preview | check | `npx vercel deploy --yes` | A preview deploy. Set the value regex to `(https://\S+\.vercel\.app)` to show the URL. | no | yes |
| env pull | oneshot | `npx vercel env pull .env.local --yes` | Downloads env vars, secrets included, into `.env.local` | no | no |
| tail | service | `npx wrangler tail` | Live Cloudflare Worker logs in the log drawer | no | no |
| purge CDN | oneshot | `curl -fsS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" --data '{"purge_everything":true}'` | Clears the whole Cloudflare cache. Needs `CF_ZONE_ID` and `CF_API_TOKEN` in your shell. | yes | no |
| tf plan | check | `terraform plan -no-color \| grep -E '^(Plan:\|No changes)'` | `Plan: 1 to add, 0 to change, 0 to destroy.` | no | yes |
| pods | check | `kubectl get pods --no-headers \| awk '{print $3}' \| sort \| uniq -c \| awk '{printf "%s %s  ", $1, $2}'` | `5 Running  1 CrashLoopBackOff` in the current context | no | yes |
| restart | oneshot | `kubectl rollout restart deployment/web` | Rolling restart. Change `web` to your deployment's name. | yes | no |
| aws acct | check | `aws sts get-caller-identity --query Account --output text` | The AWS account you are signed in to. Check it before you touch infrastructure. | no | yes |

## Tunnels and webhooks

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| tunnel | service | `cloudflared tunnel --url http://localhost:3000` | A public `trycloudflare.com` URL, printed in the log | no | no |
| ngrok | service | `ngrok http 3000 --log=stdout` | The public URL is on the `url=` log line | no | no |
| stripe | service | `stripe listen --forward-to localhost:3000/api/webhooks/stripe` | Forwards test webhooks. The signing secret appears in the log. | no | no |
| trigger | oneshot | `stripe trigger payment_intent.succeeded` | Sends a test-mode event to your webhook | no | yes |

## Frontend and design

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| lighthouse | check | `npx lighthouse "$PLOINK_URL" --only-categories=performance --output=json --output-path=stdout --quiet --chrome-flags="--headless=new" \| jq '.categories.performance.score * 100 \| round'` | `92` performance score. Needs Chrome. | no | yes |
| sitemap | check | `n=$(curl -fsS "$PLOINK_URL/sitemap.xml" \| grep -c '<loc>') && echo "$n URLs"` | `84 URLs`. Red when the sitemap is missing or empty. | no | yes |
| links | check | `npx linkinator "$PLOINK_URL" --recurse` | The summary line. Red when any link is broken. | no | yes |
| big imgs | check | `echo "$(find . -path ./node_modules -prune -o -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \) -size +500k -print \| wc -l \| tr -d ' ') over 500 KB"` | Images that are worth compressing | no | yes |
| screenshot | oneshot | `mkdir -p screenshots && npx playwright screenshot --full-page "$PLOINK_URL" "screenshots/$(date +%Y%m%d-%H%M).png"` | A full-page PNG of the live site. Good for design reviews. | no | yes |

## Mobile

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| sim open | oneshot | `xcrun simctl openurl booted "$PLOINK_URL"` | Opens the site in the running iOS Simulator | no | yes |
| expo | service | `CI=1 npx expo start` | The Metro bundler. `CI=1` stops it from waiting for keyboard input. | no | yes |
| testflight | oneshot | `fastlane beta` | Builds and uploads to TestFlight, if your Fastfile has a `beta` lane | yes | no |
| derived | oneshot | `rm -rf ~/Library/Developer/Xcode/DerivedData` | Clears Xcode's build cache. Safe, because Xcode rebuilds it. | no | no |

## Agents

These run an agent from a key. Ploink v1 shows the answer in the log drawer; v2 adds streaming, cost and time. All of them are "Agents: no", so an agent can't start another agent.

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| review | oneshot | `git diff \| claude -p "Review this diff for bugs and risky changes. Reply in at most 8 bullets." --max-budget-usd 0.5` | A quick second opinion before you commit | no | no |
| commit msg | check | `git diff --staged \| claude -p "Write a one-line Conventional Commits message for this diff. Output only the message."` | The message on the readout, ready to copy | no | no |
| notes | oneshot | `git log --oneline "$(git describe --tags --abbrev=0)"..HEAD \| claude -p "Write short release notes from these commits, grouped as Features, Fixes and Other."` | Release notes since the last tag | no | no |
| standup | oneshot | `git log --since=yesterday --author="$(git config user.email)" --oneline \| claude -p "Turn these commits into a 3-line standup update."` | | no | no |
| why fail | oneshot | `npm test 2>&1 \| tail -n 80 \| claude -p "Why do these tests fail? Answer in 3 bullets with file:line."` | | no | no |
| fix lint | oneshot | `codex exec --sandbox workspace-write "Run npm run lint and fix every error without changing behavior."` | Codex edits files in the project folder | yes | no |

## Mac housekeeping

| Name | Kind | Command | Shows / notes | Hold | Agents |
|---|---|---|---|---|---|
| awake | service | `caffeinate -dims` | Keeps the Mac and display awake while the key is on. Good for long builds. | no | no |
| ports | check | `lsof -nP -iTCP -sTCP:LISTEN \| awk 'NR>1 {sub(/.*:/, "", $9); print $9}' \| sort -un \| head -8 \| tr '\n' ' '` | `3000 5432 6379`: what is listening right now | no | yes |
| kill 3000 | oneshot | `lsof -ti tcp:3000 \| xargs kill` | Stops whatever holds port 3000. Does nothing when the port is free. | yes | no |
| disk | check | `df -h / \| awk 'NR==2 {print $4 " free"}'` | `57Gi free` | no | yes |
| brew up | oneshot | `brew upgrade` | Updates Homebrew packages | no | no |

## Picking a starter set

A bay has room for 6 keys. What Ploink does today:

- **Detected when you add a folder:** `health` (when a site URL is found; it also runs after every deploy, and agents may press it) and `dev` (the `dev`, `develop`, `serve` or `start:dev` script, as a service; agents may not press it until you allow it).
- **One-click suggestions in the bay editor:** `pull`, `fetch`, `test`, `lint` and `types`, plus `health` when the bay has a website.

Worth detecting next, in this order:

| Order | Template | Suggest it when |
|---|---|---|
| 1 | `test` | `package.json` has a `test` script that is not npm's placeholder (`echo "Error: no test specified"`) |
| 2 | `pull` | The folder is a git repo with an upstream branch |
| 3 | `compose` | `docker-compose.yml`, `docker-compose.yaml`, `compose.yml` or `compose.yaml` exists |
| 4 | `studio` | `prisma/schema.prisma` exists |

These are also easy to detect and worth offering as suggestions:

- `storybook`: a `storybook` script or a `.storybook/` folder.
- `e2e`: a `playwright.config.*` file.
- `lint` and `types`: a `lint` script, or a `tsconfig.json`.
- `stripe`: `stripe` in `package.json` dependencies.
- `tail`: a `wrangler.toml` or `wrangler.jsonc`.
- `vc preview`: a `.vercel/` folder.
- `tf plan`: any `*.tf` file in the folder.
- `expo`: `expo` in `package.json` dependencies.
- `django`: a `manage.py` file.
