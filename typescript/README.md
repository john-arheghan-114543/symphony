# Symphony — TypeScript reference implementation

TypeScript implementation of the [Symphony (Claude Code + GitHub) spec](../SPEC-CLAUDE-GITHUB.md),
extended with **Azure DevOps work-item** support.

Symphony is a long-running automation service that continuously reads work from an issue tracker,
creates an isolated workspace per issue, and runs a Claude Code session inside it. This
implementation ships with a real-time web dashboard (`http://127.0.0.1:4747/`).

Two trackers are supported today:

| Tracker        | Read work | Open PRs | Auto-rebase on merge conflict |
| -------------- | --------- | -------- | ----------------------------- |
| GitHub         | ✓         | ✓        | ✓ (`rebase.enabled: true`)    |
| Azure DevOps   | ✓         | ✓        | — (planned, see [AZURE-DEVOPS-V2.md](./AZURE-DEVOPS-V2.md)) |

## Requirements

- Node.js ≥ 20
- [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI installed on `PATH`
- (Optional but recommended) [`gh`](https://cli.github.com/) for GitHub workflows / [`az`](https://learn.microsoft.com/cli/azure/) (with `az devops` + `az boards` extensions) for ADO workflows — Claude Code uses these to write back to the tracker from inside its sessions.
- Tracker credentials:
  - **GitHub**: a PAT exported as `GITHUB_TOKEN`, set in a `.env` file (see below), or referenced explicitly in your `WORKFLOW.md`.
  - **Azure DevOps**: a PAT exported as `ADO_PAT` with `Work Items: Read & Write` and `Code: Read` scopes. Create one at `https://dev.azure.com/{org}/_usersSettings/tokens`.
- Claude Code credentials (`ANTHROPIC_API_KEY`, OAuth login, or Bedrock/Vertex creds)

### Using a `.env` file

Symphony auto-loads environment variables from these files (first-match wins; shell exports
always override):

1. `<workflow-dir>/.env.local`
2. `<workflow-dir>/.env`
3. `<cwd>/.env.local`
4. `<cwd>/.env`

Copy [`.env.example`](./.env.example) to `.env` next to your `WORKFLOW.md` and drop your
`GITHUB_TOKEN` there. Skip auto-loading with `--no-env-file`, or point at custom files with
`--env-file path/to/file` (repeatable).

## Install & run

```bash
cd typescript
npm install
npm run build
npm start -- /path/to/your-repo/WORKFLOW.md
```

Or run from source via `tsx`:

```bash
npm run dev -- /path/to/your-repo/WORKFLOW.md
```

The dashboard becomes available at `http://127.0.0.1:4747/`.

### CLI options

```
symphony [path-to-WORKFLOW.md] [options]

  --host <addr>      HTTP/UI bind host (default 127.0.0.1)
  --port <num>       HTTP/UI bind port (default 4747)
  --no-ui            Don't serve the dashboard
  --log-level <lvl>  debug|info|warn|error (default info)
```

When the workflow argument is omitted, Symphony looks for `./WORKFLOW.md` in the current
working directory (per spec §5.1).

## Configuration

All runtime behavior lives in a `WORKFLOW.md`-style file. Two reference workflows ship
with this repo: [`WORKFLOW.md`](./WORKFLOW.md) for GitHub and
[`WORKFLOW-ado.md`](./WORKFLOW-ado.md) for Azure DevOps. Symphony hot-reloads the file
on change.

### Minimum required fields — GitHub

```yaml
tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  repository: owner/repo

claude:
  command: claude
```

### Minimum required fields — Azure DevOps

```yaml
tracker:
  kind: azuredevops
  api_key: $ADO_PAT
  organization: your-ado-org
  project: YourProject
  repository: YourRepo            # ADO git repo for the agent to clone

claude:
  command: claude
```

Optional ADO knobs: `endpoint:` (override for ADO Server / on-prem; default `https://dev.azure.com`),
`work_item_types:`, `area_path:`, `iteration_path:`, plus the same `assignee_filter`, `label_filters`,
`active_states`, `terminal_states` that GitHub uses. See [`WORKFLOW-ado.md`](./WORKFLOW-ado.md) for
the fully-annotated example.

The PR-conflict / auto-rebase loop is GitHub-only in v1 — for ADO, `rebase.enabled` is silently
ignored. See the v2 plan in [AZURE-DEVOPS-V2.md](./AZURE-DEVOPS-V2.md) for how the ADO equivalent
will land.

## Running two trackers side by side

Each Symphony process owns exactly one workflow file, one tracker, one workspace root, and one
dashboard port. To track both GitHub and Azure DevOps from the same machine, start two processes:

```powershell
# Terminal 1 — GitHub (default port 4747)
$env:GITHUB_TOKEN = "<github-pat>"
node dist/cli.js WORKFLOW.md

# Terminal 2 — Azure DevOps on a separate port + workspace root
$env:ADO_PAT = "<ado-pat>"
node dist/cli.js WORKFLOW-ado.md --port 4748
```

Then visit `http://127.0.0.1:4747/` and `http://127.0.0.1:4748/` in your browser.

> [!IMPORTANT]
> Both workflow files **must** point at different `workspace.root` directories.
> Issue numbers can collide across trackers (e.g. GitHub `#123` and ADO work item `#123` would
> land in the same directory). Symphony does not enforce this — set distinct paths yourself.

## Architecture

The implementation follows the layering recommended by the spec:

| Layer             | Module                              |
| ----------------- | ------------------------------------ |
| Policy            | `WORKFLOW.md` / `WORKFLOW-ado.md`    |
| Configuration     | `src/workflow/{loader,config}.ts`    |
| Coordination      | `src/orchestrator/orchestrator.ts`   |
| Execution         | `src/agent/claude.ts`, `src/workspace/manager.ts` |
| Integration       | `src/tracker/index.ts` (factory) → `github.ts` / `ado.ts` |
| Observability     | `src/logging/logger.ts`, `src/http/server.ts`, `web/` |

The orchestrator is the single authority for scheduling state. Workers run as Promises
inside the main Node.js process and communicate state changes back to the orchestrator.
Each Claude Code turn is a fresh `bash -lc "claude -p … --output-format stream-json --verbose"`
subprocess; continuation turns within the same worker run use `--resume <session_id>`.

## HTTP API

| Endpoint                       | Description                              |
| ------------------------------- | ---------------------------------------- |
| `GET /api/v1/state`             | Snapshot (running, retrying, totals)     |
| `GET /api/v1/events`            | Server-Sent Events stream                |
| `GET /api/v1/issue/<ident>`     | URL-encoded `<owner>/<repo>#<number>`    |
| `GET /api/v1/logs?limit=200`    | Recent log lines                         |
| `POST /api/v1/refresh`          | Trigger an immediate poll tick           |

## Trust posture

This implementation defaults to `permission_mode: bypassPermissions` and does not filter
allowed tools, matching the "high-trust" example in spec §10.5. Run it only against
trusted repositories. To tighten the harness, set in your `WORKFLOW.md`:

```yaml
claude:
  permission_mode: default
  allowed_tools:
    - Read
    - Edit
    - Write
    - Glob
    - Grep
    - Bash(git:*)
    - Bash(gh:*)
    - Bash(npm:test*)
```

## Conformance notes (vs. spec §17/§18)

- **REQUIRED**: workflow loader, typed config, dynamic reload, single-authority orchestrator,
  GitHub candidate fetch / state refresh / terminal sweep, workspace manager + hooks,
  Claude Code stream-json runner, exponential retry queue, structured logging, snapshot API.
- **RECOMMENDED**: HTTP server + SSE dashboard, ETag-aware tracking (the GraphQL endpoint
  is always used for candidates per the spec; REST polling is not exercised).
- **Deferred**: GitHub App credential token minting (config plumbing is in place; minting
  is left for a follow-up), Projects v2 priority field reads beyond single-select/number,
  `github_graphql` MCP extension, restart-recovery of retry queue.

## License

Apache 2.0, same as the parent repository.
