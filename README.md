# Symphony for GitHub Projects

A TypeScript implementation of [Symphony](https://github.com/openai/symphony) targeting
**GitHub Projects** as the issue tracker, based on the
[Symphony SPEC](./SPEC.md).

Symphony turns project work into isolated, autonomous implementation runs — allowing teams to
manage work instead of supervising coding agents. The upstream reference implementation uses Linear
as its tracker; this project adapts the same architecture for GitHub Projects.

> **Status:** Engineering preview. Suitable for evaluation in trusted environments.

## Choose your execution option

### Option 1. Make your own

Tell your favorite coding agent to implement a Symphony runtime in your language from the following spec:

- [Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md)
- This repo’s GitHub Projects adaptation: [`SPEC.md`](./SPEC.md)

This is the recommended path if you want full control, custom architecture, or a different runtime stack.

### Option 2. Use our experimental reference implementation

Use this repository as a working reference implementation:

```bash
git clone https://github.com/t0yohei/symphony-github-projects.git
cd symphony-github-projects
npm install
npm run build
npm start
```

You can also start quickly via GitHub Actions workflows (for CI validation / periodic smoke checks) in
`.github/workflows/ci.yml`.

## How It Works

```
GitHub Projects (issue tracker)
    ↓  polling (configurable interval)
Symphony Orchestrator
    ↓  per-issue workspace isolation
    ↓  launches coding agent (Codex app-server)
Coding Agent
    ↓  implements changes, creates PRs
GitHub Projects status updated
```

1. **Poll** — The orchestrator polls a GitHub Project board for items in active states (e.g. `Todo`, `In Progress`).
2. **Isolate** — Each work item gets a dedicated workspace directory, bootstrapped via configurable hooks.
3. **Dispatch** — A coding agent (Codex in app-server mode) is launched inside the workspace with a rendered prompt.
4. **Multi-turn** — The agent works through multiple turns (up to `max_turns`) until the task is complete.
5. **Reconcile** — On every tick the orchestrator checks tracker state; if an item moves to a terminal state, the agent is stopped and the workspace is cleaned up.

## Prerequisites

- **Node.js** ≥ 20
- **GitHub token** with access to the target repository and project board
- **Codex CLI** installed and available as `codex app-server` (or a custom command)
- A GitHub Project (classic or ProjectV2) with status columns

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/kouka-t0yohei/symphony-github-projects.git
cd symphony-github-projects
npm install
```

### 2. Set environment variables

Following this repo's [SPEC](./SPEC.md), configuration
values are resolved from runtime environment variables — not from `.env` files. Set them in your
shell before starting the service:

```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
```

The `WORKFLOW.md` front matter references these variables with `$VAR_NAME` syntax (e.g.
`tokenEnv: GITHUB_TOKEN`). The config resolver reads them from `process.env` at startup.

### 3. Create your WORKFLOW.md

Copy the example and customize it for your project:

```bash
cp examples/WORKFLOW.md ./WORKFLOW.md
```

A minimal `WORKFLOW.md`:

```yaml
---
tracker:
  kind: github_projects

runtime:
  poll_interval_ms: 30000
  max_concurrency: 2

workspace:
  root: ~/symphony-workspaces

hooks:
  timeout_ms: 120000
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
    npm install

agent:
  command: codex app-server
  max_turns: 20

extensions:
  github_projects:
    owner: your-org
    project_number: 1
    token_env: GITHUB_TOKEN
---

You are working on GitHub Project item {{ issue.identifier }}.

Title: {{ issue.title }}
Description: {{ issue.description }}

Follow the repository's coding standards. Write tests for new functionality.
Create a pull request when the implementation is complete.
```

The YAML front matter configures runtime behavior; the Markdown body is the prompt template
sent to the coding agent for each work item. Template variables use
[Liquid](https://liquidjs.com/) syntax.

### 4. Build and run

```bash
npm run build
npm start
# or
node dist/cli.js
```

## WORKFLOW.md Reference

The `WORKFLOW.md` file is the single source of truth for orchestrator behavior. It is designed
to be version-controlled alongside your code.

### Front Matter Keys

Core contract (canonical):

- `tracker.kind` — must be `github_projects`
- `runtime.poll_interval_ms` / `runtime.max_concurrency`
- `runtime.retry.{continuation_delay_ms,failure_base_delay_ms,failure_multiplier,failure_max_delay_ms}`
- `workspace.root`
- `agent.command`, `agent.args`, `agent.max_turns`
- `agent.timeouts.{turn_timeout_ms,read_timeout_ms,stall_timeout_ms,hooks_timeout_ms}`
- `hooks.{after_create,before_run,after_run,before_remove,timeout_ms}`

GitHub Projects extension namespace:

- `extensions.github_projects.owner`
- `extensions.github_projects.project_number`
- `extensions.github_projects.token_env`
- `extensions.github_projects.type`

Compatibility mapping is built-in for existing keys (`polling.intervalMs`, `workspace.baseDir`,
`agent.maxTurns`, `tracker.github.*`, and camelCase timeout/retry fields), so older WORKFLOW files
continue to load while runtime uses one canonical typed model.

### Prompt Template

The Markdown body supports [Liquid](https://liquidjs.com/) template variables:

- `{{ issue.identifier }}` — Work item identifier
- `{{ issue.title }}` — Title
- `{{ issue.description }}` — Description/body
- `{{ issue.state }}` — Current state
- `{{ issue.labels }}` — Labels array
- `{{ attempt }}` — `null` on first run, integer on retries

Unknown variables and filters raise errors (strict mode).

### Hot Reload

The orchestrator watches `WORKFLOW.md` for changes and re-applies configuration without restart.
Invalid changes keep the last known good config and log an error.

## Architecture

```
src/
├── agent/
│   └── codex-app-server.ts    # Codex app-server subprocess integration
├── bootstrap.ts               # Wires loader → tracker → logger → runtime
├── config/
│   ├── resolver.ts            # Typed config getters with defaults + env resolution
│   └── runtime-config.ts      # Canonical runtime config types
├── logging/
│   └── logger.ts              # Structured JSON logger
├── model/
│   └── work-item.ts           # Normalized work-item model
├── orchestrator/
│   ├── reconciler.ts          # Tracker state sync + stall detection
│   └── runtime.ts             # Poll/tick loop with bounded concurrency
├── prompt/
│   └── template.ts            # Liquid prompt renderer
├── tracker/
│   ├── adapter.ts             # Tracker adapter interface
│   ├── github-projects-writer.ts  # GitHub Projects write path (status updates)
│   └── graphql-client.ts      # GitHub GraphQL client
├── workflow/
│   ├── contract.ts            # WORKFLOW.md contract + validation
│   ├── hot-reload.ts          # File watcher + dynamic config reload
│   └── loader.ts              # WORKFLOW.md parser (YAML front matter + prompt body)
└── workspace/
    └── hooks.ts               # Workspace lifecycle hooks (after_create, before_run, etc.)
```

## Development

```bash
npm run lint          # ESLint
npm run format        # Prettier (write)
npm run format:check  # Prettier (check only)
npm run typecheck     # TypeScript type check
npm run build         # Compile to dist/
npm run test          # Build + run tests
```

### CI

GitHub Actions runs on PRs and `main` pushes:

- `npm ci` → `npm run lint` → `npm run test` → `npm run build`

Workflow file: `.github/workflows/ci.yml`

## Differences from Upstream Symphony

| Aspect          | [openai/symphony](https://github.com/openai/symphony) | This project                     |
| --------------- | ------------------------------------------------------ | -------------------------------- |
| Tracker         | Linear                                                 | GitHub Projects (ProjectV2 API)  |
| Language        | Elixir/OTP (reference)                                 | TypeScript / Node.js             |
| State tracking  | Linear issue states                                    | GitHub Project board columns     |
| SPEC compliance | Reference implementation                               | Follows SPEC direction           |

## License

[Apache License 2.0](LICENSE)
