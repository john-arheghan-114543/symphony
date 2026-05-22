---
tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  repository: john-arheghan-114543/mobile
  state_source: labels
  state_label_prefix: "status:"
  active_states: ["Todo", "In Progress","Open"]
  terminal_states: ["Done", "Cancelled", "Wont Fix", "Duplicate"]
  priority_source: labels
  priority_label_pattern: "^p(\\d)$"
  assignee_filter: ["@me"]
  label_filters:
    include: ["feat"]
    exclude: ["needs-human"]

polling:
  interval_ms: 30000
  use_etag: true

workspace:
  root: C:/neldevsrc/agentcode/workspaces

hooks:
  after_create: |
    git clone --depth=1 \
      https://x-access-token:${GITHUB_TOKEN}@github.com/${SYMPHONY_ISSUE_REPOSITORY}.git .
    git config user.email "symphony-bot@example.com"
    git config user.name  "Symphony Bot"
  before_run: |
    git fetch origin
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
    git checkout -B "symphony/${SYMPHONY_ISSUE_BRANCH_NAME}" "origin/${DEFAULT_BRANCH}"
  after_run: |
    git status --short || true

agent:
  max_concurrent_agents: 4
  max_turns: 8
  max_retry_backoff_ms: 300000

claude:
  command: claude
  model: claude-opus-4-7[1m]
  permission_mode: bypassPermissions
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

# Issue {{ issue.identifier }}: {{ issue.title }}

Repository: {{ issue.repository }}
Labels: {{ issue.labels | join: ", " }}
Assignees: {{ issue.assignees | join: ", " }}

{% if attempt %}
> This is retry/continuation attempt #{{ attempt }}.
{% endif %}

## Description

{{ issue.description }}

## Your task

1. Read the issue body and any linked references.
2. Make the required changes on the current branch.
3. Run the project's tests (e.g. `npm test`, `pytest`, `mix test`) and ensure they pass.
4. Use `gh` to:
   - open a pull request when the work is ready for review,
   - add the `needs-review` label to this issue,
   - and post a short summary comment linking the PR.
5. When the PR is open and the issue is labeled `needs-review`, your work is done — stop.

If you hit something you can't resolve (missing context, broken environment, ambiguous
requirements), add the `needs-human` label, comment with your blockers, and stop. Do not
fabricate solutions.
