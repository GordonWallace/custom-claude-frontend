# Custom Claude Frontend

A local, single-user, Projects-style web app: a coordinator session starts threads that run in parallel, each backed by Claude Code.

> **Status: milestone M3.** Each project has a project chat with a coordinator that starts threads, which run in parallel up to a concurrency cap and report back when they finish. Every session gets the project's memory file, shows how full its context is and marks compactions, and Subscription work shows its estimated share of your plan. Threads run real Claude Code sessions in either mode, with tool approvals in the UI, stop and resume across restarts.

## Runner modes

Every session runs the same Claude Code engine through one of two runners. The active mode is always shown in the header badge.

| Mode | Badge | How it runs | Billed to |
| --- | --- | --- | --- |
| Subscription | **Subscription: your Claude plan** (green), with the plan's measured 5-hour and weekly usage | The Agent SDK driving your installed `claude` CLI, with your own login | Your Claude plan's usage limits |
| API | **API: metered billing** (amber, dashed), with estimated spend | The Agent SDK driving its bundled Claude Code | The `ANTHROPIC_API_KEY` account, per token |

Both modes are the same runner (`server/src/runners/sdkRunner.ts`) with a different executable and environment, so tool approvals, resume and events work identically. In Subscription mode the app removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and every `CLAUDE_CODE_USE_*` provider flag from each `claude` process, so billing can't silently fall back to an API account. If the key is set anyway, the badge says it is being ignored. The app never handles your Claude login: you sign in with the CLI yourself.

## Requirements

- Node.js 22.13 or newer (the app uses Node's built-in `node:sqlite`, so there is nothing native to compile) and pnpm 10 (`corepack enable` gives you pnpm).
- For Subscription mode: Claude Code 2.0.0 or newer, signed in (`claude auth login`).
- For API mode: `ANTHROPIC_API_KEY` set in the environment the server starts in.

## Run it

```sh
pnpm install
pnpm dev          # server on 127.0.0.1:4317, UI on http://127.0.0.1:5173
```

Or build once and serve the UI from the server:

```sh
pnpm build
pnpm start        # http://127.0.0.1:4317
```

## Using it

The screen has three panes: projects and their threads on the left, the project chat in the centre, and the open thread on the right.

- A first project (`data/workspaces/default`) is created on first start. **New** in the sidebar adds a project pointing at any folder, which becomes every session's working directory.
- **The project chat** talks to the coordinator, a Claude Code session whose job is to delegate. Ask for something like "research A, B and C" and it starts one thread per piece of work, each shown as a card with its live status. It answers quick questions itself.
- **Threads** run in parallel, up to the concurrency cap (default 3, in Settings). Extra threads show **Queued** until a slot frees up; **Cancel** drops a queued thread's input. The coordinator itself never waits for a slot.
- When a thread the coordinator started finishes a run, the coordinator gets a notice with the thread's outcome and its final message, which threads are told to make a summary of no more than 2,000 characters. If something doesn't fit, the summary tells the coordinator to read the full thread. A summary that runs past 4,000 characters is cut, with a note saying where the rest is. You can also message any thread directly, and **New chat** starts a thread of your own that doesn't report back.
- Each run shows which mode it ran in. If you switch modes, the next message in an older thread asks once before continuing it in the new mode. Both modes share the same on-disk session, so the conversation carries over.
- When Claude wants to use a tool that needs approval, the thread shows **Waiting on you** and an approval card (Allow, Allow for this session, Deny). Approvals survive a page reload.
- **Project memory** is `MEMORY.md` in the project folder. Every session gets it in its prompt and adds durable facts and decisions to it with the memory tools, so something one thread learns is known by the next. **Memory** in the project chat's header edits it.
- **The context meter** in each header shows how full the session's context window is, with a tick where Claude Code compacts automatically. A compaction shows in the timeline with the size before and after.
- **Fresh session** in the project chat's header retires the coordinator's session when the chat has grown large. Its next reply starts a new session that knows the memory and the list of threads but not the earlier conversation.
- **Plan share** in each header estimates what that thread (or, in the project chat, the whole project) has used of your plan's weekly and 5-hour windows. Your plan only reports an account-wide total, so the app splits it by each run's API-price value and learns from your own meter how many points a dollar of work moves it. Until the meter has moved during app work, it says "calibrating" and shows the API-price value instead. Usage from claude.ai or other clients isn't charged to any thread.
- **Stop** interrupts the current run. Runs cut off by a server restart are marked stopped; the next message resumes the session.
- **Copy terminal resume command** gives `cd <workspace> && claude --resume <session>`, which opens the thread in your own terminal. (The CLI's interactive `/resume` picker doesn't list sessions started this way; resuming by id works.)
- Plan usage is the account-wide figure the CLI reports on each Subscription run (an undocumented signal), so usage from claude.ai or other clients counts too.

## Configuration

Copy `config.example.json` to `config.json` (it's git-ignored). Every field is optional.

| Field | Env override | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `CCF_MODE` | none | Default runner mode, `api` or `subscription`. With neither set, the UI asks on first launch. |
| `port` | `CCF_PORT` | `4317` | Server port (always bound to 127.0.0.1). |
| `dataDir` | `CCF_DATA_DIR` | `./data` | Where the SQLite database lives. |
| `claudePath` | `CCF_CLAUDE_PATH` | `claude` | The `claude` CLI used in Subscription mode. |
| `concurrency` | | `3` | Default cap on threads running at once (the coordinator doesn't count). |
| `workspacesDir` | | `<dataDir>/workspaces` | Where the default project's workspace is created. |
| `maxTurns` | | `50` | Cap on agent turns per run, so a runaway session stops on its own. |

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
```

A switch re-checks the target runner first. If it isn't usable (no API key, CLI missing, too old or signed out), the server answers `409` with the reason in `reason`, and the mode stays as it was. `GET /api/runtime?refresh` skips the 15-second health cache.

Threads:

| Method and path | Purpose |
| --- | --- |
| `GET` / `POST /api/projects` | List or create projects (`{ "name", "workspacePath" }`) |
| `GET` / `POST /api/projects/:id/threads` | List or create threads |
| `GET /api/threads/:id` | Thread, messages, runs, pending approvals and the resume command |
| `POST /api/threads/:id/messages` | Send `{ "text" }`; `409 mode_changed` asks you to resend with `"continueInMode"` |
| `POST /api/threads/:id/interrupt` | Stop the current run |
| `GET` / `PUT /api/projects/:id/memory` | Read or replace the project's `MEMORY.md` (`{ "text" }`) |
| `GET /api/projects/:id/usage` | Estimated plan share per thread and for the project, with the calibration behind it |
| `POST /api/projects/:id/coordinator/reset` | Start a fresh coordinator session on the next message |
| `POST /api/approvals/:id` | Answer `{ "behavior": "allow" \| "deny", "always"?: true }` |
| `GET /api/runs/:id/events` | Normalized events of one run |

Live updates (runtime, threads, messages, approvals) stream over the WebSocket at `/api/events`.

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
- `server/`: Fastify, `node:sqlite`, the `SessionRunner` interface with one SDK runner and two launch profiles, the thread service and scheduler, the app's MCP server, approvals, the role prompts and the SessionStart hook (`server/hooks/post-hook.mjs`) that reports each session's id.
- `web/`: React and Vite.

`pnpm test`, `pnpm typecheck` and `pnpm build` run across all packages.
