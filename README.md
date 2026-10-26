# Custom Claude Frontend

A single-user, Projects-style web app: a coordinator session starts threads that run in parallel, each backed by Claude Code, on this machine or on other machines you add as nodes.

> **Status: milestone M6.** Each project has a project chat with a coordinator that starts threads, which run in parallel and report back when they finish. Threads run real Claude Code sessions in either mode, with tool approvals in the UI, memory, a context meter and plan-share estimates. Threads of a git-repo project can run on other machines (nodes), each in its own worktree and branch, and move between nodes when one is drained, stopped or goes offline. The app works from your phone over Tailscale with a password.

## Runner modes

Every session runs the same Claude Code engine through one of two runners. The active mode is always shown in the header badge.

| Mode | Badge | How it runs | Billed to |
| --- | --- | --- | --- |
| Subscription | **Subscription: your Claude plan** (green), with the plan's measured 5-hour and weekly usage | The Agent SDK driving your installed `claude` CLI, with your own login | Your Claude plan's usage limits |
| API | **API: metered billing** (amber, dashed), with estimated spend | The Agent SDK driving its bundled Claude Code | The `ANTHROPIC_API_KEY` account, per token |

Both modes are the same runner (`server/src/runners/sdkRunner.ts`) with a different executable and environment, so tool approvals, resume and events work identically. In Subscription mode the app removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and every `CLAUDE_CODE_USE_*` provider flag from each `claude` process, so billing can't silently fall back to an API account. If the key is set anyway, the badge says it is being ignored. The app never handles your Claude login: you sign in with the CLI yourself.

## Set it up

You need Node.js 22.13 or newer (the app uses Node's built-in `node:sqlite`, so there is nothing native to compile) and pnpm 10 (`corepack enable` gives you pnpm). Then:

```sh
git clone https://github.com/GordonWallace/custom-claude-frontend.git
cd custom-claude-frontend
pnpm install
```

Set up at least one mode. You can set up both and switch whenever you like.

**Subscription mode** uses your own Claude plan through Claude Code, the `claude` CLI. You bring your own login; the app never sees it.

1. Install Claude Code 2.0.0 or newer (`npm install -g @anthropic-ai/claude-code`, or see the Claude Code docs).
2. Sign in with your Claude account: `claude auth login`. Check it with `claude auth status`.
3. If `claude` isn't on the `PATH` the server starts with, set `claudePath` in `config.json`.

**API mode** bills an Anthropic API key per token, using the Claude Code that ships inside the Agent SDK.

1. Create a key in the Anthropic Console.
2. Start the server with it in the environment: `export ANTHROPIC_API_KEY=sk-ant-...`.

Then start the app:

```sh
pnpm dev          # server on 127.0.0.1:4317, UI on http://127.0.0.1:5173
```

Or build once and serve the UI from the server:

```sh
pnpm build
pnpm start        # http://127.0.0.1:4317
```

On first launch, if neither `config.json` nor `CCF_MODE` picks a mode, the UI asks you to choose one. The badge in the header always says which mode new messages use.

## Using it

The screen has three panes: projects and their threads on the left, the project chat in the centre, and the open thread on the right.

- A first project (`data/workspaces/default`) is created on first start. **New** in the sidebar adds a project, either a **git repo** (threads clone it on whichever node runs them, each on its own branch) or a **folder here** (every session works in that folder on this machine).
- **The project chat** talks to the coordinator, a Claude Code session whose job is to delegate. Ask for something like "research A, B and C" and it starts one thread per piece of work, each shown as a card with its live status. It answers quick questions itself.
- **Threads** run in parallel, up to the concurrency cap (default 3, in Settings). Extra threads show **Queued** until a slot frees up; **Cancel** drops a queued thread's input. The coordinator itself never waits for a slot.
- When a thread finishes a run the coordinator asked for (its first run, or one after a coordinator follow-up), the coordinator gets a notice with the thread's outcome and its final message, which threads are told to make a summary of no more than 2,000 characters. If something doesn't fit, the summary tells the coordinator to read the full thread. A summary that runs past 4,000 characters is cut, with a note saying where the rest is. You can also message any thread directly, and **New chat** starts a thread of your own. A run you started by writing in a thread doesn't report back: the coordinator doesn't reply to it, but its next turn starts with a short background note of what you asked and what the thread answered, so it stays aware.
- Each run shows which mode it ran in. If you switch modes, the next message in an older thread asks once before continuing it in the new mode. Both modes share the same on-disk session, so the conversation carries over.
- When Claude wants to use a tool that needs approval, the thread shows **Waiting on you** and an approval card (Allow, Allow for this session, Deny). Approvals survive a page reload.
- Tool calls are hidden by default; turn on **Settings › Display › Show tool calls** to see each command, edit and search with its result (saved per browser). Briefs and follow-ups the coordinator sends a thread, and the updates threads send back to the project chat, show as one line until you click them.
- Busy threads show a progress line in the thread list and their header: the step they're on in Claude Code's own task list (threads are told to keep one for multi-step work), or the tool they're running, how long the run has gone, and how long this thread's runs usually take (the middle of its past runs, or the project's). It's measured, not a prediction. A thread waiting on an approval says so.
- Under each message box, **Model** and **Thinking** pick that chat's model and thinking level from its next run. **Default** follows **Settings › Models and thinking**, which sets separate defaults for project chats and threads (unset, Claude Code picks). Thinking is Off or an effort level from Low to Max. The model list is the one your Claude Code reports, refreshed on each run.
- **Settings › Tool approvals** decides how much asks. The default, **Auto-approve, except risky commands**, lets edits, reads and ordinary shell commands run on their own and only asks for things like recursive deletes, force pushes, `sudo`, piping a download into a shell or publishing a package (the list is in `server/src/autoApprove.ts`). **Ask every time** and **Approve everything** are the other choices. Questions Claude asks you always reach you.
- **Project memory** is `MEMORY.md` in the project folder. Every session gets it in its prompt and adds durable facts and decisions to it with the memory tools, so something one thread learns is known by the next. **Memory** in the project chat's header edits it.
- **The context meter** in each header shows how full the session's context window is, with a tick where Claude Code compacts automatically. A compaction shows in the timeline with the size before and after.
- **Fresh session** in the project chat's header retires the coordinator's session when the chat has grown large. Its next reply starts a new session that knows the memory and the list of threads but not the earlier conversation.
- **Plan share** in each header estimates what that thread (or, in the project chat, the whole project) has used of your plan's weekly and 5-hour windows. Your plan only reports an account-wide total, so the app splits it by each run's API-price value and learns from your own meter how many points a dollar of work moves it. Until the meter has moved during app work, it says "calibrating" and shows the API-price value instead. Usage from claude.ai or other clients isn't charged to any thread.
- Claude's replies render as Markdown (headings, lists, tables, code). Raw HTML in a reply is shown as text, never run.
- **Stop** interrupts the current run. Runs cut off by a server restart are marked stopped; the next message resumes the session.
- **Copy terminal resume command** gives `cd <workspace> && claude --resume <session>`, which opens the thread in your own terminal. (The CLI's interactive `/resume` picker doesn't list sessions started this way; resuming by id works.)
- Plan usage is the account-wide figure the CLI reports on each Subscription run (an undocumented signal), so usage from claude.ai or other clients counts too.

## Nodes: threads on other machines

Every thread runs on a node. This machine is the first one, so a single-machine setup needs nothing more. Add other Linux machines, such as Raspberry Pis, and threads of git-repo projects run there while this machine (the orchestrator) keeps every thread's history. Your laptop and phone are only screens: work carries on while they're closed.

**What runs where.** Project chats and local-folder projects always run on this machine. A repo project's thread runs on any enabled node with room, preferring one that already has the repo cloned, and stays on that node between runs. Each thread gets its own git worktree on branch `thread/<first 8 characters of its id>`, so parallel threads never edit the same files. After every turn the node pushes the branch if the turn made commits, and uploads the session's transcript to this machine.

**Credentials.** Under **Settings › Credentials**, save a Claude token for Subscription mode (run `claude setup-token` on a machine signed in to your plan), an API key for API mode if you use it, and a fine-grained GitHub token with read and write access to your repos' contents. They're encrypted on this machine (the key is `data/secret.key`), never shown again, and sent to a node only with the run that needs it, as environment variables. Nodes never write them to disk. This machine keeps using its own `claude` login. A node with no Claude token can still run Subscription threads if its own `claude` is signed in.

**Adding a node.** You need Tailscale on both machines (or another private network, see `allowedNetworks`), and remote access turned on here:

1. In `config.json`, set `"remoteAccess": true` and `"publicUrl": "http://<this machine's Tailscale name>:4317"`, then restart. Set a password under **Settings › Remote access**.
2. Open **Nodes › Add node** and copy the command. It points at `publicUrl`, or the address you opened the app by, or this machine's Tailscale address. It holds a pairing code that works once, for 15 minutes.
3. Run it on the new machine. It installs git and Node.js 22 with apt if they're missing, downloads the worker to `~/.ccf-node`, installs the Agent SDK (which brings Claude Code for that machine's platform), pairs, and starts the worker as a systemd user service that starts at boot. The node shows up in the Nodes view.

The node runs Claude Code from its own `claude` if one is on its `PATH`, otherwise the copy that came with the Agent SDK. Install whatever build tools your projects need on it yourself.

**The Nodes view** shows each node's state, CPU, memory and disk, whether each mode can run there and why not, its thread limit (default 2) and the threads on it. Each thread's header says which node it's on.

| State | Takes new threads | How it gets there |
| --- | --- | --- |
| Enabled | Yes, up to its limit | Paired, or **Enable** |
| Draining | No | **Drain**: running turns finish, then each thread hands off |
| Disabled | No | A drain finished, or **Stop now** |
| Offline | No | No heartbeat for 30 seconds |

**Handoff.** When a thread leaves a node (Drain, or Stop now, which interrupts the turn first), the node commits anything uncommitted as a `WIP: handing off from <node>` commit, pushes the branch, uploads the transcript and removes the worktree. The thread's next run starts on another node, which checks out the branch, restores the transcript and resumes the same session; the thread shows "Moved from A to B" and Claude is told why. A stopped turn continues by itself. If a node disappears, its running threads resume elsewhere at once from their last finished turn and last pushed commit, and Claude is told that unpushed work on the old node may be lost and is given the cut-off request again. Idle threads on an offline node wait 30 seconds for it to come back before moving.

**Remove** revokes a node's token. An online node with threads on it has to be drained first.

**Remote access.** With `remoteAccess` on, the server listens on every interface but only answers this machine, Tailscale addresses (100.64.0.0/10 and fd7a:115c:a1e0::/48) and any `allowedNetworks`. Other devices log in with the password and stay logged in for 30 days; changing the password signs them out. This machine never needs to log in. Nodes and Claude sessions use their own tokens. Because this machine holds your Claude and GitHub tokens, it's the one to protect.

## Troubleshooting

- **The badge says "Not ready".** Hover it for the reason. In Subscription mode it's usually that `claude` isn't found, is older than 2.0.0, or isn't signed in (`claude auth login`). In API mode it's a missing `ANTHROPIC_API_KEY` in the server's environment; restart the server after setting it.
- **"ANTHROPIC_API_KEY is set but ignored for runs".** You're in Subscription mode with a key in the environment. That's fine: the app strips it from every `claude` process so your plan is used. Unset it if you'd rather not see the chip.
- **The CLI is signed in with an API key or another provider.** Subscription mode refuses to run, because the work wouldn't land on your plan. Run `claude auth login` with your Claude account, or use API mode.
- **A thread says it hit a rate limit or usage limit.** Your plan's limits apply across every thread and every other Claude client. Lower the concurrency cap in Settings, or wait for the window to reset (the header shows when).
- **A thread stopped after many steps.** Runs end after `maxTurns` agent turns (default 50). Send another message to continue.
- **The API spend turned red.** Estimated API spend passed `spendWarnUsd` (default $10). It's a warning only; nothing is stopped.
- **Port 4317 is taken.** Set `port` in `config.json` or `CCF_PORT`.
- **Add node shows setup steps instead of a command.** No other machine can reach this one yet: remote access is off, or the app found no Tailscale address (or address in `allowedNetworks`) on this machine and `publicUrl` isn't set. Do the steps it lists, then click Add node again.
- **A node shows Offline.** Check the worker on it: `systemctl --user status ccf-node` and `journalctl --user -u ccf-node -f`. It reconnects on its own when the orchestrator is reachable again. If it says the orchestrator refused it, the node was removed: pair it again.
- **A node can't run Subscription threads.** Save a Claude token under Settings › Credentials, or sign in to `claude` on the node.
- **A thread's push failed.** The thread shows the git error. Usually the GitHub token is missing, expired, or lacks contents write access to that repo.
- **Another device gets "Set a password on the orchestrator machine first".** Set one under Settings › Remote access on this machine.
- **Starting over.** Stop the server and delete `data/` (the database and the default workspace). Your Claude sessions stay in `~/.claude`.

## Configuration

Copy `config.example.json` to `config.json` (it's git-ignored). Every field is optional.

| Field | Env override | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `CCF_MODE` | none | Default runner mode, `api` or `subscription`. With neither set, the UI asks on first launch. |
| `port` | `CCF_PORT` | `4317` | Server port (bound to 127.0.0.1 unless `remoteAccess` is on). |
| `dataDir` | `CCF_DATA_DIR` | `./data` | Where the SQLite database lives. |
| `claudePath` | `CCF_CLAUDE_PATH` | `claude` | The `claude` CLI used in Subscription mode. |
| `concurrency` | | `3` | Default cap on threads running at once (the coordinator doesn't count). |
| `workspacesDir` | | `<dataDir>/workspaces` | Where the default project's workspace is created. |
| `maxTurns` | | `50` | Cap on agent turns per run, so a runaway session stops on its own. |
| `spendWarnUsd` | | `10` | Estimated API-mode spend at which the badge turns red; `0` turns the warning off. |
| `approvals` | | `"auto"` | Default tool-approval policy: `"ask"`, `"auto"` (everything except risky commands) or `"all"`. A choice made in Settings wins. |
| `remoteAccess` | `CCF_REMOTE_ACCESS=1` | `false` | Listen on every interface for other devices and nodes, with a password (see Nodes). |
| `publicUrl` | `CCF_PUBLIC_URL` | none | This server's URL as other machines reach it, used in the Add node command. |
| `allowedNetworks` | | `[]` | Extra networks to accept besides Tailscale, in CIDR form, e.g. `["192.168.1.0/24"]`. |
| `localThreadLimit` | | `concurrency` | How many threads this machine runs at once as a node (the Nodes view can change it). |

A mode chosen in the UI or through the API is saved in the database and wins over the configured default.

## HTTP API

```sh
# Current mode, both runners' health, active runs, concurrency cap
curl http://127.0.0.1:4317/api/runtime

# Switch mode (new runs only; runs in flight finish in their original mode)
curl -X PUT http://127.0.0.1:4317/api/runtime \
  -H 'content-type: application/json' -d '{"mode":"subscription"}'

# Change the concurrency cap
curl -X PUT http://127.0.0.1:4317/api/runtime \
  -H 'content-type: application/json' -d '{"concurrency":2}'

# Default model and thinking for threads (null goes back to Claude Code's default)
curl -X PUT http://127.0.0.1:4317/api/runtime \
  -H 'content-type: application/json' -d '{"sessionDefaults":{"thread":{"model":"sonnet","thinking":"medium"}}}'

# Change the tool-approval policy: "ask", "auto" or "all"
curl -X PUT http://127.0.0.1:4317/api/runtime \
  -H 'content-type: application/json' -d '{"approvals":"auto"}'
```

A switch re-checks the target runner first. If it isn't usable (no API key, CLI missing, too old or signed out), the server answers `409` with the reason in `reason`, and the mode stays as it was. `GET /api/runtime?refresh` skips the 15-second health cache.

Threads:

| Method and path | Purpose |
| --- | --- |
| `GET` / `POST /api/projects` | List or create projects (`{ "name", "workspacePath" }` or `{ "name", "repoUrl", "baseBranch"? }`) |
| `GET` / `POST /api/projects/:id/threads` | List or create threads |
| `GET /api/threads/:id` | Thread, messages, runs, pending approvals and the resume command |
| `PATCH /api/threads/:id` | A thread's own `{ "model", "thinking" }` (`null` uses the default) |
| `POST /api/threads/:id/messages` | Send `{ "text" }`; `409 mode_changed` asks you to resend with `"continueInMode"` |
| `POST /api/threads/:id/interrupt` | Stop the current run |
| `GET` / `PUT /api/projects/:id/memory` | Read or replace the project's `MEMORY.md` (`{ "text" }`) |
| `GET /api/projects/:id/usage` | Estimated plan share per thread and for the project, with the calibration behind it |
| `POST /api/projects/:id/coordinator/reset` | Start a fresh coordinator session on the next message |
| `POST /api/approvals/:id` | Answer `{ "behavior": "allow" \| "deny", "always"?: true }` |
| `GET /api/runs/:id/events` | Normalized events of one run |
| `GET /api/nodes` | Every node with its state, resources, readiness per mode and threads |
| `PATCH /api/nodes/:id` | `{ "action": "enable" \| "drain" \| "stop" }`, `{ "threadLimit": n }` or `{ "name" }` |
| `DELETE /api/nodes/:id` | Remove a node and revoke its token |
| `POST /api/nodes/pairing` | A one-time pairing code and the install command |
| `GET /api/secrets`, `PUT /api/secrets/:name` | Which credentials are set; save one with `{ "value" }` (empty removes it). Values are never returned |
| `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout`, `PUT /api/auth/password` | Remote access login |

Live updates (runtime, threads, messages, approvals, nodes) stream over the WebSocket at `/api/events`. Nodes connect to `/api/nodes/connect`, pair through `/api/nodes/pair` and download the worker from `/api/nodes/install.sh` and `/api/nodes/worker/*`.

### The app's MCP server

Every session gets the app's own MCP server, `POST /mcp` (streamable HTTP, stateless), named `app`. Each run carries a token in its `Authorization` header that tells the server which project and session is calling, and the token stops working when the run ends. Its tools are pre-approved, so they never ask you.

| Tool | Available to | What it does |
| --- | --- | --- |
| `start_thread(title, brief)` | Coordinator | Creates a thread, queues the brief as its first turn and returns its id at once |
| `message_thread(thread_id, text)` | Coordinator | Sends a follow-up into a thread's current run, or queues it |
| `list_threads()` | Coordinator | Every thread's id, status and the first line of its latest reply |
| `read_thread(thread_id, last_n)` | Coordinator | A thread's recent messages in full (no tool output) |
| `read_memory()` / `write_memory(text)` | Every session | Read or replace `MEMORY.md` in the project workspace |

The coordinator can't use Claude Code's own subagents (`Task`), so delegated work always shows up as threads you can open. The role prompts that tell the coordinator and threads how to behave are in `server/prompts/`; edits apply to the next run without a restart.

## Layout

- `shared/`: TypeScript types shared by server and UI.
- `server/`: Fastify, `node:sqlite`, the `SessionRunner` interface with one SDK runner and two launch profiles, the thread service and scheduler, the app's MCP server, approvals, the role prompts and the SessionStart hook (`server/hooks/post-hook.mjs`) that reports each session's id. `server/src/nodes/` is the node protocol: the agent that runs threads (in-process for this machine, in the worker elsewhere), the hub that talks to nodes, git worktrees and transcripts. `server/assets/install.sh` is the node install script.
- `node/`: the node worker, bundled into one file (`node/dist/worker.mjs`) that nodes download.
- `web/`: React and Vite.

`pnpm test`, `pnpm typecheck` and `pnpm build` run across all packages.
