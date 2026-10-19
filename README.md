# Custom Claude Frontend

A local, single-user, Projects-style web app: a coordinator session starts threads that run in parallel, each backed by Claude Code.

> **Status: milestone M1.** Chat threads run real Claude Code sessions in either mode, with tool approvals in the UI, stop, resume across restarts and the measured plan usage in the header. The coordinator and parallel threads arrive in M2.

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

- A first project (`data/workspaces/default`) and chat are created on first start. **New** in the sidebar adds a project pointing at any folder, which becomes the sessions' working directory.
- Each run shows which mode it ran in. If you switch modes, the next message in an older thread asks once before continuing it in the new mode. Both modes share the same on-disk session, so the conversation carries over.
- When Claude wants to use a tool that needs approval, the thread shows **Waiting on you** and an approval card (Allow, Allow for this session, Deny). Approvals survive a page reload.
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
| `concurrency` | | `3` | Default cap on threads running at once. |
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
| `POST /api/approvals/:id` | Answer `{ "behavior": "allow" \| "deny", "always"?: true }` |
| `GET /api/runs/:id/events` | Normalized events of one run |

Live updates (runtime, threads, messages, approvals) stream over the WebSocket at `/api/events`.

## Layout

- `shared/`: TypeScript types shared by server and UI.
- `server/`: Fastify, `node:sqlite`, the `SessionRunner` interface with one SDK runner and two launch profiles, the thread service, approvals and the SessionStart hook (`server/hooks/post-hook.mjs`) that reports each session's id.
- `web/`: React and Vite.

`pnpm test`, `pnpm typecheck` and `pnpm build` run across all packages.
