// GitHub tracker adapter (Section 11). REST/GraphQL with pagination, rate-limit
// awareness, ETag-conditional polling, and state normalization.

import type {
  BlockerRef,
  Issue,
  RateLimitSnapshot,
  TrackerConfig,
  TrackerConfigGitHub,
} from "../types.js";
import type { RebaseCapableTracker } from "./index.js";
import { log } from "../logging/logger.js";

const USER_AGENT = "symphony-ts/0.1";
const REST_API_VERSION = "2022-11-28";
const NETWORK_TIMEOUT_MS = 30_000;

export class TrackerError extends Error {
  constructor(public code: string, message: string, public payload?: unknown) {
    super(message);
    this.name = "TrackerError";
  }
}

export interface FetchResult {
  issues: Issue[];
  rate: RateLimitSnapshot;
}

interface InternalContext {
  cfg: TrackerConfigGitHub;
  token: string;
  graphqlEndpoint: string;
  restEndpoint: string;
  rate: RateLimitSnapshot;
  etagCache: Map<string, { etag: string; payload: unknown }>;
  viewerLogin: string | null;
}

export class GitHubTracker implements RebaseCapableTracker {
  readonly kind = "github" as const;
  private ctx: InternalContext;

  constructor(cfg: TrackerConfig) {
    if (cfg.kind !== "github") {
      throw new TrackerError("unsupported_tracker_kind", `Unsupported kind: ${cfg.kind}`);
    }
    const token = cfg.api_key;
    if (!token) {
      throw new TrackerError("missing_tracker_api_key", "tracker.api_key is required for this profile");
    }
    const isGhCom = cfg.endpoint === "https://api.github.com";
    const graphqlEndpoint = isGhCom
      ? "https://api.github.com/graphql"
      : `${cfg.endpoint.replace(/\/$/, "")}/graphql`;
    const restEndpoint = cfg.endpoint.replace(/\/$/, "");
    this.ctx = {
      cfg,
      token,
      graphqlEndpoint,
      restEndpoint,
      rate: {},
      etagCache: new Map(),
      viewerLogin: null,
    };
  }

  getRateLimits(): RateLimitSnapshot {
    return { ...this.ctx.rate };
  }

  /**
   * Authenticated HTTPS clone URL. Embeds the access token; never log.
   * Returns null when the issue has no repository slug (shouldn't happen
   * for properly-fetched GitHub issues but defensive nonetheless).
   */
  cloneUrl(issue: Issue): string | null {
    if (!issue.repository) return null;
    return `https://x-access-token:${this.ctx.token}@github.com/${issue.repository}.git`;
  }

  /** Resolve `@me` in assignee_filter to the authenticated viewer's login. */
  private async ensureViewerLogin(): Promise<void> {
    if (this.ctx.viewerLogin != null) return;
    const needsViewer = (this.ctx.cfg.assignee_filter || []).some(
      (a) => a.toLowerCase() === "@me",
    );
    if (!needsViewer) {
      this.ctx.viewerLogin = "";
      return;
    }
    try {
      const result = await this.graphql(`query { viewer { login } }`, {});
      const login = result.data?.viewer?.login;
      if (typeof login === "string" && login.length > 0) {
        this.ctx.viewerLogin = login.toLowerCase();
        log.info("github_viewer_resolved", { login: this.ctx.viewerLogin });
      } else {
        this.ctx.viewerLogin = "";
        log.warn("github_viewer_unresolved", { reason: "no_login_in_response" });
      }
    } catch (e: any) {
      this.ctx.viewerLogin = "";
      log.warn("github_viewer_unresolved", { error: e?.message });
    }
  }

  async fetchCandidateIssues(): Promise<FetchResult> {
    await this.ensureViewerLogin();
    const { cfg } = this.ctx;
    if (cfg.project_id) {
      return await this.fetchFromProject();
    }
    if (cfg.repository) {
      return await this.fetchFromRepository();
    }
    throw new TrackerError(
      "missing_tracker_repository_or_project",
      "Configure tracker.repository or tracker.project_id",
    );
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<FetchResult> {
    if (stateNames.length === 0) return { issues: [], rate: this.getRateLimits() };
    return await this.fetchTerminalSweep(stateNames);
  }

  /**
   * Fetch issues currently labeled `needs-review` along with the mergeable
   * state of the open PR on their corresponding `symphony/<branch>` head.
   * Used by the orchestrator's review sweep to detect PRs that need rebasing.
   */
  async fetchParkedForReview(label = "needs-review"): Promise<FetchResult> {
    if (!this.ctx.cfg.repository) return { issues: [], rate: this.getRateLimits() };
    const [owner, name] = this.ctx.cfg.repository.split("/", 2);
    if (!owner || !name) return { issues: [], rate: this.getRateLimits() };
    const query = `
      query($owner:String!, $name:String!, $labels:[String!]) {
        repository(owner:$owner, name:$name) {
          issues(states: OPEN, labels: $labels, first: 100, orderBy:{field: UPDATED_AT, direction: DESC}) {
            nodes {
              id
              number
              title
              state
              stateReason
              url
              createdAt
              updatedAt
              body
              repository { nameWithOwner }
              labels(first: 50) { nodes { name } }
              assignees(first: 20) { nodes { login } }
            }
          }
          pullRequests(states: OPEN, first: 100, orderBy:{field: UPDATED_AT, direction: DESC}) {
            nodes { number url headRefName mergeable state }
          }
        }
        rateLimit { remaining resetAt cost }
      }`;
    const result = await this.graphql(query, { owner, name, labels: [label] });
    this.updateRateFromGraphQL(result.data?.rateLimit);
    const issueNodes = (result.data?.repository?.issues?.nodes || []) as any[];
    const prNodes = (result.data?.repository?.pullRequests?.nodes || []) as any[];
    const prByHead = new Map<string, any>();
    for (const pr of prNodes) {
      if (pr?.headRefName) prByHead.set(pr.headRefName, pr);
    }
    const issues = issueNodes.filter(Boolean).map((n) => {
      const issue = this.normalizeIssueNode(n);
      const head = symphonyBranchRef(issue.branch_name);
      const pr = head ? prByHead.get(head) : undefined;
      issue.pr = pr
        ? {
            number: pr.number,
            url: pr.url,
            head_ref_name: pr.headRefName,
            mergeable: (pr.mergeable as any) || "UNKNOWN",
            state: (pr.state as any) || "OPEN",
          }
        : null;
      return issue;
    });
    return { issues, rate: this.getRateLimits() };
  }

  /**
   * Add and/or remove labels on a single issue via the REST API.
   * Idempotent — missing-label DELETEs return 404 which we silently swallow.
   */
  async swapLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    add: string[],
    remove: string[],
  ): Promise<void> {
    const base = `${this.ctx.restEndpoint}/repos/${owner}/${repo}/issues/${issueNumber}/labels`;
    const headers = {
      Authorization: `Bearer ${this.ctx.token}`,
      "User-Agent": USER_AGENT,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": REST_API_VERSION,
      "Content-Type": "application/json",
    };
    if (add.length > 0) {
      const resp = await fetchWithTimeout(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ labels: add }),
      });
      this.updateRateFromHeaders(resp.headers);
      if (!resp.ok) {
        throw new TrackerError(
          "github_label_add_failed",
          `POST labels HTTP ${resp.status} ${resp.statusText}`,
        );
      }
    }
    for (const label of remove) {
      const resp = await fetchWithTimeout(`${base}/${encodeURIComponent(label)}`, {
        method: "DELETE",
        headers,
      });
      this.updateRateFromHeaders(resp.headers);
      // 404 = label wasn't on the issue. Treat as success (idempotent).
      if (!resp.ok && resp.status !== 404) {
        throw new TrackerError(
          "github_label_remove_failed",
          `DELETE label ${label}: HTTP ${resp.status} ${resp.statusText}`,
        );
      }
    }
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<FetchResult> {
    if (ids.length === 0) return { issues: [], rate: this.getRateLimits() };
    const query = `
      query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Issue {
            id
            number
            title
            state
            stateReason
            url
            createdAt
            updatedAt
            body
            repository { nameWithOwner }
            labels(first: 50) { nodes { name } }
            assignees(first: 20) { nodes { login } }
            projectItems(first: 10) {
              nodes {
                project { id }
                fieldValues(first: 50) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2SingleSelectField { name } }
                    }
                    ... on ProjectV2ItemFieldNumberValue {
                      number
                      field { ... on ProjectV2Field { name } }
                    }
                  }
                }
              }
            }
          }
        }
        rateLimit { remaining resetAt cost }
      }
    `;
    const result = await this.graphql(query, { ids });
    const nodes = (result.data?.nodes || []) as any[];
    const issues = nodes.filter(Boolean).map((n) => this.normalizeIssueNode(n));
    this.updateRateFromGraphQL(result.data?.rateLimit);
    return { issues, rate: this.getRateLimits() };
  }

  private async fetchFromRepository(): Promise<FetchResult> {
    const [owner, name] = (this.ctx.cfg.repository as string).split("/", 2);
    if (!owner || !name) {
      throw new TrackerError(
        "missing_tracker_repository_or_project",
        `Invalid repository slug: ${this.ctx.cfg.repository}`,
      );
    }
    const all: Issue[] = [];
    let after: string | null = null;
    let pages = 0;
    while (true) {
      pages++;
      if (pages > 50) {
        log.warn("github candidate pagination cap reached", { pages });
        break;
      }
      const query = `
        query($owner:String!, $name:String!, $after:String) {
          repository(owner:$owner, name:$name) {
            issues(states: OPEN, first: 50, after: $after, orderBy:{field: UPDATED_AT, direction: DESC}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                number
                title
                state
                stateReason
                url
                createdAt
                updatedAt
                body
                repository { nameWithOwner }
                labels(first: 50) { nodes { name } }
                assignees(first: 20) { nodes { login } }
                projectItems(first: 10) {
                  nodes {
                    project { id }
                    fieldValues(first: 50) {
                      nodes {
                        ... on ProjectV2ItemFieldSingleSelectValue {
                          name
                          field { ... on ProjectV2SingleSelectField { name } }
                        }
                        ... on ProjectV2ItemFieldNumberValue {
                          number
                          field { ... on ProjectV2Field { name } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          rateLimit { remaining resetAt cost }
        }`;
      const result = await this.graphql(query, { owner, name, after });
      this.updateRateFromGraphQL(result.data?.rateLimit);
      const issuesPage = result.data?.repository?.issues;
      if (!issuesPage) break;
      const nodes = (issuesPage.nodes || []) as any[];
      for (const n of nodes) {
        all.push(this.normalizeIssueNode(n));
      }
      if (!issuesPage.pageInfo?.hasNextPage) break;
      if (!issuesPage.pageInfo?.endCursor) {
        throw new TrackerError("github_missing_end_cursor", "pagination integrity error");
      }
      after = issuesPage.pageInfo.endCursor;
    }
    return { issues: this.filterCandidates(all), rate: this.getRateLimits() };
  }

  private async fetchFromProject(): Promise<FetchResult> {
    const projectId = this.ctx.cfg.project_id as string;
    const all: Issue[] = [];
    let after: string | null = null;
    let pages = 0;
    while (true) {
      pages++;
      if (pages > 50) break;
      const query = `
        query($id:ID!, $after:String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 50, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  content {
                    ... on Issue {
                      id
                      number
                      title
                      state
                      stateReason
                      url
                      createdAt
                      updatedAt
                      body
                      repository { nameWithOwner }
                      labels(first: 50) { nodes { name } }
                      assignees(first: 20) { nodes { login } }
                    }
                  }
                  fieldValues(first: 50) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field { ... on ProjectV2SingleSelectField { name } }
                      }
                      ... on ProjectV2ItemFieldNumberValue {
                        number
                        field { ... on ProjectV2Field { name } }
                      }
                    }
                  }
                }
              }
            }
          }
          rateLimit { remaining resetAt cost }
        }`;
      const result = await this.graphql(query, { id: projectId, after });
      this.updateRateFromGraphQL(result.data?.rateLimit);
      const items = result.data?.node?.items;
      if (!items) break;
      const nodes = (items.nodes || []) as any[];
      for (const item of nodes) {
        const content = item?.content;
        if (!content?.id) continue;
        const normalized = this.normalizeIssueNode({
          ...content,
          projectItems: {
            nodes: [
              {
                project: { id: projectId },
                fieldValues: item.fieldValues,
              },
            ],
          },
        });
        all.push(normalized);
      }
      if (!items.pageInfo?.hasNextPage) break;
      if (!items.pageInfo?.endCursor) {
        throw new TrackerError("github_missing_end_cursor", "pagination integrity error");
      }
      after = items.pageInfo.endCursor;
    }
    return { issues: this.filterCandidates(all), rate: this.getRateLimits() };
  }

  private async fetchTerminalSweep(stateNames: string[]): Promise<FetchResult> {
    // Bounded by 30-day lookback per spec 11.1/8.6
    if (!this.ctx.cfg.repository) return { issues: [], rate: this.getRateLimits() };
    const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
    const [owner, name] = this.ctx.cfg.repository.split("/", 2);
    const queryStr = `repo:${owner}/${name} updated:>=${since} state:closed`;
    const query = `
      query($q:String!) {
        search(query: $q, type: ISSUE, first: 100) {
          nodes {
            ... on Issue {
              id
              identifier: number
              number
              title
              state
              stateReason
              url
              createdAt
              updatedAt
              body
              repository { nameWithOwner }
              labels(first: 30) { nodes { name } }
              assignees(first: 10) { nodes { login } }
            }
          }
        }
        rateLimit { remaining resetAt cost }
      }`;
    const result = await this.graphql(query, { q: queryStr });
    this.updateRateFromGraphQL(result.data?.rateLimit);
    const nodes = (result.data?.search?.nodes || []).filter(Boolean) as any[];
    return {
      issues: nodes.map((n) => this.normalizeIssueNode(n)),
      rate: this.getRateLimits(),
    };
  }

  private filterCandidates(issues: Issue[]): Issue[] {
    const cfg = this.ctx.cfg;
    const activeLower = new Set(cfg.active_states.map((s) => s.toLowerCase()));
    const termLower = new Set(cfg.terminal_states.map((s) => s.toLowerCase()));
    const includeLabels = cfg.label_filters?.include?.map((s) => s.toLowerCase());
    const excludeLabels = cfg.label_filters?.exclude?.map((s) => s.toLowerCase());
    const assigneeFilter = cfg.assignee_filter
      ?.map((s) => s.toLowerCase())
      .map((s) => (s === "@me" ? this.ctx.viewerLogin || "" : s))
      .filter((s) => s.length > 0);
    return issues.filter((i) => {
      if (i.github_state !== "open") return false;
      const stateLower = (i.state || "").toLowerCase();
      if (!activeLower.has(stateLower)) return false;
      if (termLower.has(stateLower)) return false;
      if (assigneeFilter && assigneeFilter.length > 0) {
        const ok = i.assignees.some((a) => assigneeFilter.includes(a));
        if (!ok) return false;
      }
      if (includeLabels && includeLabels.length > 0) {
        const ok = i.labels.some((l) => includeLabels.includes(l));
        if (!ok) return false;
      }
      if (excludeLabels && excludeLabels.length > 0) {
        const bad = i.labels.some((l) => excludeLabels.includes(l));
        if (bad) return false;
      }
      return true;
    });
  }

  private normalizeIssueNode(node: any): Issue {
    const cfg = this.ctx.cfg;
    const repoSlug =
      node?.repository?.nameWithOwner ||
      cfg.repository ||
      "unknown/unknown";
    const labels: string[] = (node?.labels?.nodes || [])
      .map((l: any) => (l?.name || "").toLowerCase())
      .filter(Boolean);
    const assignees: string[] = (node?.assignees?.nodes || [])
      .map((a: any) => (a?.login || "").toLowerCase())
      .filter(Boolean);

    const number = node?.number ?? 0;
    const identifier = `${repoSlug}#${number}`;

    let state = "Open";
    if (cfg.state_source === "closed_flag") {
      if (node?.state === "CLOSED" || node?.state === "closed") {
        state = node?.stateReason === "NOT_PLANNED" ? "Cancelled" : "Done";
      } else {
        state = "Open";
      }
    } else if (cfg.state_source === "labels") {
      const prefix = cfg.state_label_prefix.toLowerCase();
      const match = labels.find((l) => l.startsWith(prefix));
      if (match) {
        const suffix = match.slice(prefix.length).replace(/[-_]/g, " ").trim();
        state = suffix
          .split(" ")
          .filter(Boolean)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      } else {
        state = node?.state?.toLowerCase() === "closed" ? "Closed" : "Open";
      }
    } else if (cfg.state_source === "project") {
      const projItems = (node?.projectItems?.nodes || []) as any[];
      const target = cfg.project_id
        ? projItems.find((p) => p?.project?.id === cfg.project_id) || projItems[0]
        : projItems[0];
      const fieldName = cfg.state_field.toLowerCase();
      let derived: string | null = null;
      for (const fv of target?.fieldValues?.nodes || []) {
        if (fv?.field?.name?.toLowerCase() === fieldName) {
          derived = fv?.name ?? (fv?.number != null ? String(fv.number) : null);
          break;
        }
      }
      if (derived) state = derived;
      else state = node?.state?.toLowerCase() === "closed" ? "Closed" : "Open";
    }

    let priority: number | null = null;
    if (cfg.priority_source === "labels") {
      try {
        const re = new RegExp(cfg.priority_label_pattern, "i");
        for (const l of labels) {
          const m = re.exec(l);
          if (m && m[1]) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n)) {
              priority = n;
              break;
            }
          }
        }
      } catch {
        priority = null;
      }
    } else if (cfg.priority_source === "project") {
      const projItems = (node?.projectItems?.nodes || []) as any[];
      const target = cfg.project_id
        ? projItems.find((p) => p?.project?.id === cfg.project_id) || projItems[0]
        : projItems[0];
      const fieldName = cfg.priority_field.toLowerCase();
      for (const fv of target?.fieldValues?.nodes || []) {
        if (fv?.field?.name?.toLowerCase() === fieldName) {
          if (typeof fv?.number === "number") {
            priority = Math.floor(fv.number);
          } else if (fv?.name) {
            const n = parseInt(fv.name, 10);
            if (Number.isFinite(n)) priority = n;
          }
          break;
        }
      }
    }

    const blocked_by = deriveBlockers(node, repoSlug);

    return {
      id: node?.id,
      identifier,
      number,
      repository: repoSlug,
      title: node?.title || "",
      description: typeof node?.body === "string" ? node.body : null,
      priority,
      state,
      github_state: (node?.state || "OPEN").toLowerCase() === "closed" ? "closed" : "open",
      branch_name: defaultBranchName(number, node?.title || ""),
      url: node?.url || null,
      labels,
      assignees,
      blocked_by,
      created_at: node?.createdAt || null,
      updated_at: node?.updatedAt || null,
    };
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<{
    data: any;
    headers: Headers;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(this.ctx.graphqlEndpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.ctx.token}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e: any) {
      clearTimeout(timer);
      throw new TrackerError("github_api_request", e.message);
    }
    clearTimeout(timer);
    this.updateRateFromHeaders(resp.headers);

    if (resp.status === 401 || resp.status === 403 || resp.status === 429) {
      const retryAfterHeader = resp.headers.get("retry-after");
      if (retryAfterHeader) {
        const sec = parseInt(retryAfterHeader, 10);
        if (Number.isFinite(sec)) this.ctx.rate.retry_after_ms = sec * 1000;
        throw new TrackerError("github_secondary_rate_limit", `HTTP ${resp.status} secondary rate limit`);
      }
      const remaining = resp.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        throw new TrackerError("github_rate_limited", `HTTP ${resp.status} rate limit exhausted`);
      }
      // fall through with status error
    }

    if (!resp.ok) {
      throw new TrackerError("github_api_status", `HTTP ${resp.status} ${resp.statusText}`);
    }

    let json: any;
    try {
      json = await resp.json();
    } catch (e: any) {
      throw new TrackerError("github_unknown_payload", `JSON parse error: ${e.message}`);
    }
    if (json?.errors && Array.isArray(json.errors) && json.errors.length > 0) {
      throw new TrackerError("github_graphql_errors", JSON.stringify(json.errors), json);
    }
    return { data: json?.data, headers: resp.headers };
  }

  private updateRateFromHeaders(headers: Headers) {
    const restRem = parseInt(headers.get("x-ratelimit-remaining") || "", 10);
    const restReset = parseInt(headers.get("x-ratelimit-reset") || "", 10);
    if (Number.isFinite(restRem)) this.ctx.rate.rest_remaining = restRem;
    if (Number.isFinite(restReset)) {
      this.ctx.rate.rest_reset_at = new Date(restReset * 1000).toISOString();
    }
  }

  private updateRateFromGraphQL(rl: any) {
    if (!rl) return;
    if (typeof rl.remaining === "number") this.ctx.rate.graphql_remaining = rl.remaining;
    if (rl.resetAt) this.ctx.rate.graphql_reset_at = rl.resetAt;
  }
}

function defaultBranchName(number: number, title: string): string {
  const slug = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 60);
  return slug ? `${number}-${slug}` : String(number);
}

/** The git head ref Symphony pushes to (matches WORKFLOW.md's before_run hook). */
export function symphonyBranchRef(branchName: string | null | undefined): string | null {
  if (!branchName) return null;
  return `symphony/${branchName}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function deriveBlockers(node: any, repoSlug: string): BlockerRef[] {
  // Body parsing for "blocked by #N" / "blocked by owner/repo#N" / "depends on owner/repo#N"
  const blockers: BlockerRef[] = [];
  const body: string = typeof node?.body === "string" ? node.body : "";
  if (body) {
    const re = /(?:blocked\s+by|depends\s+on)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const repo = m[1] || repoSlug;
      const num = m[2];
      blockers.push({ id: null, identifier: `${repo}#${num}`, state: null });
    }
  }
  // Dedup
  const seen = new Set<string>();
  return blockers.filter((b) => {
    const key = b.identifier || `${b.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
