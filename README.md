# Custom Claude Frontend

A local, single-user, Projects-style web app: a coordinator session starts threads that run in parallel, each backed by Claude Code.

> **Status: milestone M0.** The scaffold, the runner-mode switch and the header badge work. Running Claude sessions arrives in M1; projects, the coordinator and threads in M2.

## Runner modes

Every session runs the same Claude Code engine through one of two runners. The active mode is always shown in the header badge.

| Mode | Badge | How it runs | Billed to |
| --- | --- | --- | --- |
| Subscription | **Subscription: your Claude plan** (green) | Your installed `claude` CLI, with your own login | Your Claude plan's usage limits |
| API | **API: metered billing** (amber, dashed) | The Claude Agent SDK | The `ANTHROPIC_API_KEY` account, per token |

In Subscription mode the app removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and every `CLAUDE_CODE_USE_*` provider flag from each `claude` process, so billing can't silently fall back to an API account. If the key is set anyway, the badge says it is being ignored. The app never handles your Claude login: you sign in with the CLI yourself.

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

## Configuration

Copy `config.example.json` to `config.json` (it's git-ignored). Every field is optional.

| Field | Env override | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `CCF_MODE` | none | Default runner mode, `api` or `subscription`. With neither set, the UI asks on first launch. |
| `port` | `CCF_PORT` | `4317` | Server port (always bound to 127.0.0.1). |
| `dataDir` | `CCF_DATA_DIR` | `./data` | Where the SQLite database lives. |
| `claudePath` | `CCF_CLAUDE_PATH` | `claude` | The `claude` CLI used in Subscription mode. |
| `concurrency` | | `3` | Default cap on threads running at once. |

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

Live updates (mode changes and more later) stream over the WebSocket at `/api/events`.

## Layout

- `shared/`: TypeScript types shared by server and UI.
- `server/`: Fastify, `node:sqlite`, the `SessionRunner` interface and its two runners.
- `web/`: React and Vite.

`pnpm test`, `pnpm typecheck` and `pnpm build` run across all packages.
