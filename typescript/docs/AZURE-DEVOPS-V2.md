# Azure DevOps v2 — implementation plan

This document is the design and implementation roadmap for everything the
ADO tracker **does not** do in v1 (read + dispatch only). It is meant to be
picked up and executed without re-doing the discovery work.

The v1 cutover scope was:
- A `Tracker` interface and `createTracker(cfg)` factory ([src/tracker/index.ts](src/tracker/index.ts)).
- `AzureDevOpsTracker` reading work items via WIQL + `workitemsbatch` ([src/tracker/ado.ts](src/tracker/ado.ts)).
- `TrackerConfig` as a discriminated union ([src/types.ts](src/types.ts)).
- `SYMPHONY_ISSUE_REPO_URL` populated by the tracker so the `after_create` hook is tracker-agnostic.

Anything outside that bullet list is on this page.

## Scope

| Item | Priority | Sketch effort |
| --- | --- | --- |
| 1. ADO PR-conflict / auto-rebase loop | **High** | ~2 days |
| 2. Tag write-back from the orchestrator (`swapTags`) | **High** | ~½ day (prereq for #1) |
| 3. Workspace-key namespacing per tracker kind | Medium | ~2 hours |
| 4. ADO Server on-prem auth (NTLM/Negotiate) | Low | ~1 day |
| 5. OAuth flow for ADO (in lieu of PAT) | Low | ~2 days |
| 6. ADO `mergeStateStatus`-richer signals (BEHIND, BLOCKED, UNSTABLE) | Low | ~2 hours after #1 |
| 7. Cross-tracker dashboard multiplexer | Low / nice-to-have | ~1 day |

The order below is the recommended landing order — items 2 and 3 are
prerequisites for clean #1 work.

---

## 1. ADO PR-conflict / auto-rebase loop

### Motivation

When two agents work different work items in parallel, the second PR to
land often becomes unmergeable. v1 has the loop wired for GitHub via
`RebaseCapableTracker` + `reviewSweep`. The orchestrator silently no-ops
the sweep when `tracker.kind !== "github"` ([orchestrator.ts](src/orchestrator/orchestrator.ts), inside `reviewSweep`).
We want feature parity for ADO.

### Design

Mirror the GitHub loop, swap the implementation. The orchestrator already
calls `fetchParkedForReview()` + `swapLabels(...)` via the
`RebaseCapableTracker` interface. Make `AzureDevOpsTracker` implement it.

**Label model**: ADO has no native "labels" — tags are the closest analog.
The trigger label (`needs-review`) and target label (`needs-rebase`) both
become tags on the work item.

**PR detection**: ADO PR REST exposes `mergeStatus` with values
`notSet | queued | conflicts | succeeded | rejectedByPolicy | failure`.
Treat `conflicts` as our `CONFLICTING`, `notSet` / `queued` as `UNKNOWN`
(skip this tick), everything else as `MERGEABLE`.

**Branch → PR linking**: same convention as GitHub — Symphony controls
the branch name (`symphony/{slug}`), so we query PRs by `sourceRefName`.

### Files to add/modify

1. **`src/tracker/ado.ts`** — make `AzureDevOpsTracker` implement
   `RebaseCapableTracker`. Add:
   - `readonly kind = "azuredevops"` is already there — need to relax the
     `RebaseCapableTracker.kind` constraint (see §1.1 below).
   - `fetchParkedForReview(label = "needs-review")` — combined query:
     - WIQL for work items tagged with `label`,
     - `GET /repositories/{repo}/pullrequests?searchCriteria.sourceRefName=refs/heads/symphony/{slug}&searchCriteria.status=active`
       per work item (or one bulk call: `pullrequests?searchCriteria.status=active&top=200` filtered client-side by `sourceRefName`).
   - `swapTags(workItemId, add: string[], remove: string[])` — single
     `PATCH /workitems/{id}` with `op: replace, path: /fields/System.Tags`
     and a recomputed semicolon-joined tag string (ADO has no per-tag
     add/remove endpoint).
   - A `swapLabels` method matching the GitHub signature that internally
     normalizes (owner+repo+number) → workItemId and delegates to
     `swapTags`.

2. **`src/tracker/index.ts`** — broaden `RebaseCapableTracker.kind` to
   `"github" | "azuredevops"`. `isRebaseCapable(t)` becomes:
   ```ts
   return t.kind === "github" || t.kind === "azuredevops";
   ```

3. **`src/orchestrator/orchestrator.ts`** — `reviewSweep` is already
   tracker-agnostic past the `isRebaseCapable` guard. The only kind-specific
   branch is the `(owner, name) = repo.split("/")` step. Replace with a
   per-tracker `getRepoCoordinate(): { id: string | number }` helper, or
   pass the issue's full `Issue` to `swapLabels` (cleaner). Simplest
   refactor: change `swapLabels(owner, repo, num, add, remove)` to
   `swapLabels(issue, add, remove)` everywhere — issue already carries
   the routing info.

4. **`src/types.ts`** — `Issue.pr` already exists. The ADO tracker
   populates it with the matching PR's `pullRequestId` and `mergeStatus`
   (mapped to our enum). No type changes needed.

5. **`WORKFLOW-ado.md`** — add a `{% if issue.labels contains "needs-rebase" %}`
   Liquid branch to the prompt body that instructs the agent to:
   - `git fetch origin && git rebase origin/<default>`
   - resolve conflicts, run tests
   - `git push --force-with-lease`
   - `az boards work-item update --id {{ issue.number }} --fields "System.Tags=feat; needs-review"`
   - exit (the agent never touches `rebase-attempt-N` — the orchestrator
     manages it, just like for GitHub).

### Verification

- Unit-test `fetchParkedForReview` with a stubbed `fetch`: feed it a WIQL
  response with two work items, two `pullrequests` responses (one
  `conflicts`, one `succeeded`), assert the mapping.
- Live smoke: same recipe as v1 §Verification, but with two work items
  whose PRs touch the same line of the same file. Merge one, wait for
  the sweep to fire `rebase_triggered`, watch the second redispatch with
  the rebase prompt.
- Regression: ensure the GitHub path still works (the `RebaseCapableTracker`
  surface widening must not break GH).

### 1.1 Tracker shape change required

Today `RebaseCapableTracker.kind` is hard-coded to `"github"` as a type
narrower. Widening it to `"github" | "azuredevops"` is the cleanest
change. Alternative: drop the `kind` discrimination from the interface
and let `isRebaseCapable` use `typeof t.fetchParkedForReview === "function"`
as a duck-typed check. The narrowing approach is preferred — it keeps
type safety.

---

## 2. Tag write-back from the orchestrator (`swapTags`)

This is a v1.1 prerequisite for #1, but small enough to land standalone.
It lets the orchestrator (not just the agent) move work items between
states by mutating tags — symmetric with what `swapLabels` already does
for GitHub.

### Files

1. **`src/tracker/ado.ts`** — `swapTags(workItemId, add, remove)`:
   ```ts
   async swapTags(id: number, add: string[], remove: string[]): Promise<void> {
     // ADO doesn't have add/remove — fetch current, compute new, replace.
     const current = await this.fetchOne(id);
     const tagsRaw = current?.fields?.["System.Tags"] || "";
     const have = tagsRaw.split(";").map(s => s.trim()).filter(Boolean);
     const next = new Set(have.filter(t => !remove.includes(t.toLowerCase())));
     for (const a of add) next.add(a);
     const patch = [{ op: "replace", path: "/fields/System.Tags", value: [...next].join("; ") }];
     await this.request(
       `${this.ctx.orgEndpoint}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`,
       { method: "PATCH", headers: { "Content-Type": "application/json-patch+json" }, body: JSON.stringify(patch) }
     );
   }
   ```
2. Bump PAT-scope guidance in [README.md](README.md) — already mentions
   `Work Items: Read & Write`. No change.

### Race vs. concurrent agent writes

If a Claude session is mid-flight and mutating tags while the orchestrator
also swaps, last-write-wins. ADO supports `If-Match` against the work
item `rev` field on PATCH to enforce optimistic concurrency. Use it: read
`rev`, send PATCH with `If-Match: "{rev}"`, retry on 412.

### Verification

Unit-test the tag-merge math: have=`["feat","needs-review"]`,
add=`["needs-rebase","rebase-attempt-1"]`, remove=`["needs-review"]` →
result `["feat","needs-rebase","rebase-attempt-1"]` (set, order-insensitive
verification).

---

## 3. Workspace-key namespacing per tracker kind

### Motivation

Today `WorkspaceManager.createForIssue(identifier)` uses
`workspaceKey(identifier)` ([src/util/path.ts](src/util/path.ts)). For
GitHub the identifier is `owner/repo#123`, for ADO it's `Project#123`.
Two trackers with overlapping issue numbers on the same machine would
collide if they shared `workspace.root`. v1 documents "use a different
`workspace.root` per tracker"; this item enforces it.

### Design

Prepend the tracker kind to the workspace key:

```ts
// util/path.ts
export function workspaceKey(identifier: string, kind: "github" | "azuredevops"): string {
  const safe = identifier.replace(/[^A-Za-z0-9._@#-]+/g, "_");
  return `${kind}-${safe}`;
}
```

Threaded through `WorkspaceManager` constructor (carry `kind`) so every
issue dispatched by a given orchestrator gets the right prefix without
needing to pass it per-call.

### Migration

Existing GitHub workspaces have keys like `owner_repo_123`. After this
change they'd be `github-owner_repo_123` — a new directory. The
`after_create` hook re-clones cleanly. The old directory is orphaned but
harmless (and `removeForIssue` on a closed issue would no longer find it
under the old name).

Add a `migrate-workspaces.ts` one-shot script under `scripts/` that
renames `<root>/<key>` to `<root>/github-<key>` for an existing
deployment — opt-in, not run automatically.

### Files

- **`src/util/path.ts`** — `workspaceKey(id, kind)`.
- **`src/workspace/manager.ts`** — `WorkspaceManager` ctor takes `kind`;
  every internal `workspaceKey(...)` call passes it through.
- **`src/orchestrator/orchestrator.ts`** — construct `WorkspaceManager`
  with `workflow.config.tracker.kind`. Hot-reload: if `kind` flips,
  rebuild the manager (rare; flag it).
- **`scripts/migrate-workspaces.ts`** (new) — opt-in migration.

### Verification

- Unit-test `workspaceKey("foo/bar#1", "github")` → `"github-foo_bar_1"`.
- Smoke: run two Symphony processes against the SAME `workspace.root`
  with overlapping issue numbers. Both should land in their own
  prefixed directories. (Don't actually advertise this as supported —
  distinct roots are still the documented best practice.)

---

## 4. ADO Server on-prem auth (NTLM / Negotiate)

Most ADO Server installs accept PAT — the `endpoint:` knob already lets
users point at on-prem. NTLM is only needed for legacy / locked-down
deployments.

### Sketch

Add a lightweight NTLM client. Node has no built-in; pull in
[`httpntlm`](https://www.npmjs.com/package/httpntlm) or `node-fetch-with-proxy`.
Both are unmaintained — strong preference for documenting "PAT only"
and pointing users at a reverse proxy that strips NTLM if they truly
need it.

**Recommendation**: defer indefinitely. Document the limitation in
[README.md](README.md) and direct users to PAT.

---

## 5. OAuth for ADO

PAT is simpler and Microsoft's recommended path for automation accounts.
OAuth requires registering an app, a callback URL, refresh-token storage,
etc. — significant infrastructure for marginal benefit over PAT.

### Sketch

If pursued: use Microsoft's `@azure/identity` with a service-principal
credential. Replace `Authorization: Basic ${base64(":" + PAT)}` with
`Authorization: Bearer ${token}` and refresh via
`credential.getToken("499b84ac-1321-427f-aa17-267ca6975798/.default")`
(the ADO resource ID). Store nothing on disk — re-acquire per process
start.

**Recommendation**: defer until a real user asks for it.

---

## 6. ADO `mergeStateStatus`-richer signals

GitHub has `mergeStateStatus` (BEHIND, BLOCKED, UNSTABLE, etc.) that v1
ignores in favor of just `mergeable: CONFLICTING`. ADO has an analog via
the PR `_links` and the `policy/evaluations` REST API — overkill for
v1.1; revisit if the rebase loop misses real-world cases.

---

## 7. Cross-tracker dashboard multiplexer

Users running two Symphony processes today see two separate dashboards.
A small static page that fetches `/api/v1/state` from both ports and
renders a unified view would close that gap.

### Sketch

- New `web-multiplex/index.html` + `app.js` (or extend the existing
  `web/` to optionally point at multiple upstreams via a query string).
- Configure via `?upstreams=http://localhost:4747,http://localhost:4748`.
- No server-side change required — pure browser-side fan-out.

### Files

- **`web-multiplex/index.html`** (new) — same React/htm stack as `web/`.
- **`web-multiplex/app.js`** (new) — accepts a list of base URLs, fetches
  each `/api/v1/state` and `/api/v1/events`, renders merged.

### Verification

Open with `?upstreams=http://localhost:4747,http://localhost:4748` while
both processes are running. Confirm Active sessions, Tokens used, etc.
sum correctly. Disconnect one process — only that section flips to
"Disconnected", the other keeps streaming.

---

## Out of scope of this v2 plan

- **Linear**, **Jira**, **GitLab** trackers. The `Tracker` interface
  shipped in v1 is general enough — adding any of these is a matter of
  writing one file following the `ado.ts` pattern. They live in their
  own plans.
- **State-machine awareness for ADO process templates** (Agile vs Scrum
  vs Basic). We rely on the user enumerating active/terminal states.
  Process-template auto-detection is doable via `_apis/wit/workitemtypes`
  but adds operational complexity for marginal UX gain.

## Recommended order to land

1. **§2** (tag write-back) — prereq for §1, small.
2. **§3** (workspace-key namespacing) — small cleanup, removes a class
   of subtle bugs.
3. **§1** (ADO PR-conflict / rebase loop) — the headline feature. Ship
   gated behind `rebase.enabled: true` like GitHub, default off.
4. **§6** (richer merge state) — only if §1 misses cases in practice.
5. **§7** (dashboard multiplexer) — nice-to-have, owner discretion.
6. **§4 / §5** (NTLM / OAuth) — defer unless requested.
