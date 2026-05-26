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
    exclude: ["needs-human", "needs-review"]

polling:
  interval_ms: 30000
  use_etag: true

workspace:
  root: C:/neldevsrc/agentcode/workspaces

hooks:
  after_create: |
    git clone --depth=1 "${SYMPHONY_ISSUE_REPO_URL}" .
    git config user.email "symphony-bot@example.com"
    git config user.name  "Symphony Bot"
  before_run: |
    git fetch origin
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
    BRANCH="symphony/${SYMPHONY_ISSUE_BRANCH_NAME}"
    if git rev-parse --verify "refs/remotes/origin/${BRANCH}" >/dev/null 2>&1; then
      git checkout -B "${BRANCH}" "origin/${BRANCH}"
    else
      git checkout -B "${BRANCH}" "origin/${DEFAULT_BRANCH}"
    fi
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

rebase:
  enabled: true        # opt in to detect needs-review PRs with merge conflicts and auto-rebase
  max_attempts: 2       # after this many tries, escalate to needs-human
---

# Issue {{ issue.identifier }}: {{ issue.title }}

Repository: {{ issue.repository }}
Labels: {{ issue.labels | join: ", " }}
Assignees: {{ issue.assignees | join: ", " }}

{% if attempt %}
> This is retry/continuation attempt #{{ attempt }}.
{% endif %}

{% if issue.labels contains "needs-rebase" %}
## Your task — rebase this PR onto the default branch

Your existing pull request has a merge conflict with the default branch. The
orchestrator has set the `needs-rebase` label and re-dispatched you to resolve it.

1. `gh pr list --head "symphony/{{ issue.branch_name }}" --state open --json number,baseRefName,headRefName,mergeable,url`
   — confirm the PR number and base branch.
2. `git fetch origin` and `git rebase origin/$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)`.
3. For each conflict, read both sides, choose the resolution that keeps the project's tests passing.
   Do NOT just take one side blindly — understand both intents.
4. Run the project's tests (e.g. `npm test`, `pytest`, `mix test`) and iterate on conflicts until everything is green.
5. `git push --force-with-lease origin "symphony/{{ issue.branch_name }}"`.
6. Use `gh` to remove the `needs-rebase` label from this issue and re-add `needs-review`.
   **Do not touch any `rebase-attempt-N` label** — the orchestrator manages that counter.
7. Stop. Do not modify unrelated files; this turn is strictly for conflict resolution.

If after one honest attempt the conflict cannot be resolved (semantic conflict, missing context,
the project's tests can't be made to pass), add the `needs-human` label, comment with your
blockers, and stop. Do not force-push a half-broken rebase.
{% else %}
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
{% endif %}
