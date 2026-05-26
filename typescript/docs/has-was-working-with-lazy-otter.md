# Symphony — PR Conflict Detection & Self-Resolving Rebase Loop

## Context

When two Symphony agents work different issues in parallel, the second PR to land often becomes unmergeable: PR A merges → `main` moves forward → PR B's branch is now behind/conflicting. Today Symphony has **zero awareness of PR state** — the tracker fetches only issue fields, the orchestrator never inspects `mergeable`, and the agent stops as soon as it sets `needs-review`. The PR sits open with `CONFLICTING` mergeable state and nothing wakes the agent back up.

We're adding a label-driven loop:
1. Orchestrator periodically inspects the linked PR of every `needs-review` issue and, when GitHub reports `mergeable: CONFLICTING`, swaps the label `needs-review` → `needs-rebase`.
2. That label swap makes the issue eligible for candidacy again, so the orchestrator redispatches an agent on the same issue.
3. The Liquid prompt template renders a different body when `needs-rebase` is present, telling the agent to rebase onto the default branch, resolve conflicts, force-push, and put `needs-review` back.
4. The whole feature is gated behind a `rebase.enabled` config flag, off by default.

User-confirmed decisions: **rebase** (not merge), **config-gated default off**.

## Files to edit (in order)

### 1. [typescript/src/types.ts](typescript/src/types.ts) — type foundation

Add `PullRequestRef` and a `pr?: PullRequestRef | null` field on `Issue`:

```ts
export interface PullRequestRef {
  number: number;
  url: string;
  head_ref_name: string;            // e.g. "symphony/12-add-services-page"
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  state: "OPEN" | "CLOSED" | "MERGED";
}
```

Also add a `rebase` section to whichever config type lives in [typescript/src/workflow/config.ts](typescript/src/workflow/config.ts):

```ts
rebase: {
  enabled: boolean;       // default false
  max_attempts: number;   // default 2
}
```

### 2. [typescript/src/tracker/github.ts](typescript/src/tracker/github.ts) — fetch PR state, mutate labels

**Extend the three GraphQL queries** at lines 117-154, 179-218, 244-284 to pull the most recent open PR by head ref:

```graphql
... on Issue {
  # existing fields ...
  pullRequests: repository {
    pullRequests(headRefName: $branchForIssue, states: [OPEN], first: 1,
                 orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number, url, headRefName, mergeable, state }
    }
  }
}
```

Computing `$branchForIssue` is awkward inside GraphQL — instead, extract a helper `branchForIssue(issue)` (matches the `symphony/<branch_name>` convention; see [github.ts:567](typescript/src/tracker/github.ts#L567)) and do a **second** batched GraphQL call per tick that takes the candidate issues' branches and resolves their PRs. Keep this lookup query in the same file to ensure the mapping stays in lockstep.

**Branch-based lookup is preferred** over the PR's `closingIssuesReferences` because Claude agents sometimes word the close reference inconsistently ("fixes #N", "fix for #N", or bare `#N`), whereas the branch name is deterministic given Symphony owns the naming convention.

**Add a label-mutation method** on the tracker:

```ts
async swapLabels(owner: string, repo: string, issueNumber: number,
                 add: string[], remove: string[]): Promise<void>
```

Implementation: `POST /repos/{owner}/{repo}/issues/{n}/labels` for adds, `DELETE /repos/{owner}/{repo}/issues/{n}/labels/{name}` for removes. Use the same `api_key` the GraphQL client uses.

**Add a tracker method to fetch parked issues** (those with `needs-review` that are NOT in candidate set because `needs-review` is now excluded):

```ts
async fetchParkedForReview(): Promise<{ issues: Issue[]; rate: RateLimitSnapshot }>
```

This is essentially `fetchFromRepository` but with `labels: ["needs-review"]` and no `assignee_filter` short-circuit. It must populate `pr` like the candidate fetch.

### 3. [typescript/src/orchestrator/orchestrator.ts](typescript/src/orchestrator/orchestrator.ts) — review sweep

Inside `tick()` ([orchestrator.ts:135-171](typescript/src/orchestrator/orchestrator.ts#L135-L171)), **before** `fetchCandidateIssues`, run a new `reviewSweep()`:

```ts
private async reviewSweep(): Promise<void> {
  if (!this.cfg().rebase?.enabled) return;
  const { issues } = await this.tracker.fetchParkedForReview();
  for (const i of issues) {
    if (!i.pr) continue;
    if (i.pr.mergeable === "UNKNOWN") continue;        // GitHub still computing — wait
    if (i.pr.mergeable !== "CONFLICTING") continue;
    if (this.running.has(i.id) || this.claimed.has(i.id)) continue;
    const attempt = rebaseAttemptCount(i.labels);
    if (attempt >= this.cfg().rebase.max_attempts) {
      await this.tracker.swapLabels(owner, repo, i.number,
        ["needs-human"],
        ["needs-rebase", `rebase-attempt-${attempt}`]);
      log.warn("rebase_exhausted_escalated_to_human", { issue: i.identifier, attempts: attempt });
      continue;
    }
    await this.tracker.swapLabels(owner, repo, i.number,
      ["needs-rebase", `rebase-attempt-${attempt + 1}`],
      ["needs-review", attempt > 0 ? `rebase-attempt-${attempt}` : ""].filter(Boolean));
    log.info("rebase_triggered", { issue: i.identifier, attempt: attempt + 1 });
  }
}

function rebaseAttemptCount(labels: string[]): number {
  const m = labels.find(l => /^rebase-attempt-\d+$/.test(l));
  return m ? parseInt(m.split("-").pop()!, 10) : 0;
}
```

**Use a label** (`rebase-attempt-N`) as the durable counter — survives Symphony restarts, no new tracker fields, human-visible.

The `UNKNOWN` mergeable state is GitHub's "still computing" — we deliberately skip those ticks rather than risk swapping labels prematurely.

Also surface `pr` in `snapshot()` ([orchestrator.ts:730-810](typescript/src/orchestrator/orchestrator.ts#L730-L810)) so the dashboard can render it on running cards.

### 4. [typescript/WORKFLOW.md](typescript/WORKFLOW.md) — hook fix + prompt branch + config

**Three changes**:

**(a)** Add `needs-review` to `label_filters.exclude` so parked issues don't keep re-entering candidacy purely on `feat`:

```yaml
label_filters:
  include: ["feat"]
  exclude: ["needs-human", "needs-review"]
```

**(b)** Fix the destructive `before_run` hook. Today it does `git checkout -B "symphony/${SYMPHONY_ISSUE_BRANCH_NAME}" "origin/${DEFAULT_BRANCH}"`, which **silently resets the agent's existing remote branch to default-branch HEAD on every dispatch**. That would obliterate a rebase. Rewrite to prefer the existing remote branch:

```yaml
before_run: |
  git fetch origin
  DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
  BRANCH="symphony/${SYMPHONY_ISSUE_BRANCH_NAME}"
  if git rev-parse --verify "refs/remotes/origin/${BRANCH}" >/dev/null 2>&1; then
    git checkout -B "${BRANCH}" "origin/${BRANCH}"
  else
    git checkout -B "${BRANCH}" "origin/${DEFAULT_BRANCH}"
  fi
```

**(c)** Add a Liquid conditional to the prompt template for `needs-rebase` mode:

```liquid
{% if issue.labels contains "needs-rebase" %}
## Your task — rebase this PR onto the default branch

PR {{ issue.pr.url }} on branch `{{ issue.pr.head_ref_name }}` has a conflict.

1. `gh pr view {{ issue.pr.number }} --json baseRefName,headRefName,mergeable`.
2. `git fetch origin` and `git rebase origin/$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)`.
3. For each conflict, read both sides, choose the resolution that keeps tests passing.
4. Run the project's tests; iterate on conflicts until green.
5. `git push --force-with-lease origin {{ issue.pr.head_ref_name }}`.
6. Use `gh` to remove the `needs-rebase` label and re-add `needs-review`. Do NOT touch the `rebase-attempt-N` label — the orchestrator manages it.
7. Stop. Do not modify unrelated files.

If after one honest attempt the conflict can't be resolved (e.g. semantic conflict, missing context), add the `needs-human` label, comment your blockers, and stop.
{% else %}
{# existing prompt body — read issue, implement, open PR, etc. #}
{% endif %}
```

**(d)** Optional new config block:

```yaml
rebase:
  enabled: false        # opt-in; flip to true to activate
  max_attempts: 2
```

### 5. [typescript/src/prompt/render.ts](typescript/src/prompt/render.ts) — verify Liquid `contains`

Verify the Liquid engine in use (`liquidjs` per [package.json:19](typescript/package.json#L19)) supports `labels contains "X"`. It does — but the existing template uses `{{ issue.labels | join: ", " }}`, so the data shape is already array-of-strings. No code change expected, but worth checking the rendered output once.

### 6. [typescript/web/app.js](typescript/web/app.js) + [typescript/web/styles.css](typescript/web/styles.css) — surface PR state

On the running card (and ideally a future "Parked" section, deferred), show a small PR badge:

```js
${run.pr ? html`
  <a class=${"pr-badge " + run.pr.mergeable.toLowerCase()}
     href=${run.pr.url} target="_blank" onClick=${e => e.stopPropagation()}>
    PR #${run.pr.number} · ${run.pr.mergeable.toLowerCase()}
  </a>
` : null}
```

CSS: green for `mergeable`, amber for `unknown`, red for `conflicting`.

## Verification

**Unit-level** (no real PR needed):

1. **Tracker normalization**: feed `normalizeIssueNode` a fixture with `pullRequests.nodes[0] = { mergeable: "CONFLICTING", ... }`, assert `issue.pr.mergeable === "CONFLICTING"`.
2. **`reviewSweep` logic**: in-memory tracker mock returning a known set; assert `swapLabels` is called with the expected `add` / `remove` arrays.
3. **Escalation**: simulate `rebase-attempt-2` label already present + `max_attempts: 2`; assert `needs-human` is added and the loop stops triggering on subsequent ticks.
4. **UNKNOWN skip**: assert no label mutation when `mergeable === "UNKNOWN"`.

**End-to-end smoke** (manual, one-time):

1. Point WORKFLOW.md at `john-arheghan-114543/PayItModernization` (where the user's real `feat` issues live).
2. Set `rebase.enabled: true`.
3. Create issue X and issue Y, both editing the same line of the same file.
4. Let agent work issue X to PR. Merge it manually.
5. Let agent work issue Y to PR — confirm GitHub shows `mergeable: CONFLICTING`.
6. Watch Symphony logs: `rebase_triggered` should fire within one poll cycle.
7. Watch the same issue redispatch with the rebase prompt; agent rebases and force-pushes.
8. Confirm `needs-rebase` becomes `needs-review` again and PR is mergeable.

## Out of scope for v1

- **Other PR signals** (failing CI, review comments left by humans, draft state) — track separately. This v1 handles conflicts only.
- **Parked-for-review dashboard view** — pure observability; can ship after the engine is validated.
- **`mergeStateStatus`** richer signals (BEHIND, BLOCKED, UNSTABLE) — `mergeable` alone covers conflicts. Add later if needed.
- **Cross-repo PRs** — assume PRs live in the same repo as the issue (current Symphony assumption holds).
- **Race with human edits**: if a human force-pushes the branch mid-rebase, the agent's `--force-with-lease` will fail safely and the agent will report. We don't auto-recover.

## Open risks

1. **GitHub `mergeable: UNKNOWN` can persist** if the repo is large or GitHub is degraded. We skip the tick, which means a conflicted PR can sit unprocessed for several poll cycles. Acceptable for v1.
2. **Label race**: if a human swaps labels mid-tick, the orchestrator's `swapLabels` call may add a duplicate or remove a missing label. The REST DELETE-label endpoint is idempotent (404 ignored); add a try/catch in `swapLabels` so a stray race doesn't crash the sweep.
3. **`gh` CLI dependency in the rebase prompt**. Confirm `gh` is on PATH inside the workspace at runtime; if not, fall back to raw `git` + REST `curl` in the prompt.
4. **Cost**: every conflicted PR now triggers a fresh Claude session for rebase. With `max_attempts: 2` and the `needs-human` escalation, worst case per stubborn issue is two full agent runs before a human is paged. Acceptable.

## Critical files

- `c:\neldevsrc\Vscode\symphony\typescript\src\types.ts`
- `c:\neldevsrc\Vscode\symphony\typescript\src\tracker\github.ts`
- `c:\neldevsrc\Vscode\symphony\typescript\src\orchestrator\orchestrator.ts`
- `c:\neldevsrc\Vscode\symphony\typescript\src\workflow\config.ts`
- `c:\neldevsrc\Vscode\symphony\typescript\WORKFLOW.md`
- `c:\neldevsrc\Vscode\symphony\typescript\web\app.js`
- `c:\neldevsrc\Vscode\symphony\typescript\web\styles.css`
