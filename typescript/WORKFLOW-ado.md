---
# Symphony workflow targeting Azure DevOps work items.
# Run side-by-side with the GitHub workflow on a separate port:
#   symphony WORKFLOW.md       --port 4747     # GitHub
#   symphony WORKFLOW-ado.md   --port 4748     # this file
#
# IMPORTANT: use a DIFFERENT workspace.root than the GitHub workflow to
# avoid directory-name collisions between trackers (issue numbers can
# coincide across systems).

tracker:
  kind: azuredevops
  endpoint: https://dev.azure.com          # default; override for ADO Server
  organization: your-ado-org
  project: YourProject
  repository: YourRepo                     # ADO git repo for the clone URL
  api_key: $ADO_PAT                        # Personal Access Token

  # WIQL filters (all optional)
  work_item_types: ["User Story", "Bug"]
  area_path: "YourProject\\Team A"         # backslashes in YAML, doubled
  iteration_path: "YourProject\\Sprint 24"

  # State machine — Agile process defaults. Pick the ones for YOUR template.
  #   Agile:  New / Active / Resolved / Closed / Removed
  #   Scrum:  New / Approved / Committed / Done / Removed
  #   Basic:  To Do / Doing / Done
  active_states:   ["New", "Active"]
  terminal_states: ["Resolved", "Closed", "Removed"]

  assignee_filter: ["@me"]                 # native WIQL @Me macro
  label_filters:
    include: ["feat"]
    exclude: ["needs-human"]

polling:
  interval_ms: 30000
  use_etag: false                          # ADO does not use ETags

# Use a distinct workspace root so the two Symphony processes don't fight
# over directory names. Each tracker namespaces issue identifiers, but the
# workspace key today is `<repo>/<number>` and can collide across systems.
workspace:
  root: C:/neldevsrc/agentcode/workspaces-ado

hooks:
  # Tracker-agnostic clone — uses SYMPHONY_ISSUE_REPO_URL populated by
  # the ADO tracker (https://:PAT@dev.azure.com/{org}/{project}/_git/{repo}).
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

# NOTE: The PR-conflict rebase loop is GitHub-only in v1. Leave `enabled:
# false` here even if the GitHub workflow has it on — Symphony will skip
# the sweep silently when the tracker is ADO.
rebase:
  enabled: false
  max_attempts: 2
---

# Work item {{ issue.identifier }}: {{ issue.title }}

Organization / project: {{ issue.repository }}
State: {{ issue.state }}
Tags: {{ issue.labels | join: ", " }}
Assignees: {{ issue.assignees | join: ", " }}

{% if attempt %}
> This is retry/continuation attempt #{{ attempt }}.
{% endif %}

## Description

{{ issue.description }}

## Your task

1. Read the work item body and any linked references in ADO. You can use
   `az boards work-item show --id {{ issue.number }}` to fetch full
   details, including links to other items.
2. Make the required changes on the current branch (`symphony/{{ issue.branch_name }}`).
3. Run the project's tests (e.g. `npm test`, `pytest`, `dotnet test`) and ensure they pass.
4. Push your branch and open a pull request in Azure Repos:
   - `git push -u origin "symphony/{{ issue.branch_name }}"`
   - `az repos pr create --source-branch "symphony/{{ issue.branch_name }}" --work-items {{ issue.number }} --auto-complete false`
5. Tag the work item with `needs-review` and post a short comment linking the PR:
   - `az boards work-item update --id {{ issue.number }} --fields "System.Tags=feat; needs-review"`
   - `az boards work-item discussion add --id {{ issue.number }} --discussion "PR opened: <url>"`
6. When the PR is open and the work item has `needs-review`, your work is done — stop.

If you hit something you can't resolve (missing context, broken environment,
ambiguous requirements), tag the work item with `needs-human`, comment with
your blockers, and stop. Do not fabricate solutions.
