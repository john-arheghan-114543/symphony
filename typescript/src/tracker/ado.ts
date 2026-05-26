// Azure DevOps tracker adapter (v1: read + dispatch only — no PR awareness
// and no tag/label writes). Uses WIQL for candidate selection and
// workitemsbatch for field fetches. Auth is PAT via HTTP Basic.

import type {
  BlockerRef,
  Issue,
  RateLimitSnapshot,
  TrackerConfig,
  TrackerConfigAdo,
} from "../types.js";
import type { FetchResult, Tracker } from "./index.js";
import { TrackerError } from "./github.js";
import { buildCandidateWiql } from "./ado-wiql.js";
import { log } from "../logging/logger.js";

const USER_AGENT = "symphony-ts/0.1";
const NETWORK_TIMEOUT_MS = 30_000;
const API_VERSION = "7.1";
const BATCH_SIZE = 200;             // workitemsbatch hard cap
const WIQL_LOOKBACK_DAYS = 30;      // mirrors GitHub terminal sweep
const WIQL_RESULT_LIMIT = 20_000;   // ADO hard cap; warn if hit

const FIELDS = [
  "System.Id",
  "System.Title",
  "System.State",
  "System.WorkItemType",
  "System.AreaPath",
  "System.IterationPath",
  "System.TeamProject",
  "System.AssignedTo",
  "System.Tags",
  "System.CreatedDate",
  "System.ChangedDate",
  "System.Description",
  "Microsoft.VSTS.Common.Priority",
];

interface InternalContext {
  cfg: TrackerConfigAdo;
  authHeader: string;
  orgEndpoint: string;     // https://dev.azure.com/{org}
  projectEndpoint: string; // https://dev.azure.com/{org}/{project}
  rate: RateLimitSnapshot;
  terminalLower: Set<string>;
}

export class AzureDevOpsTracker implements Tracker {
  readonly kind = "azuredevops" as const;
  private ctx: InternalContext;

  constructor(cfg: TrackerConfig) {
    if (cfg.kind !== "azuredevops") {
      throw new TrackerError("unsupported_tracker_kind", `Unsupported kind: ${cfg.kind}`);
    }
    if (!cfg.api_key) {
      throw new TrackerError("missing_tracker_api_key", "tracker.api_key (PAT) is required");
    }
    if (!cfg.organization) {
      throw new TrackerError("missing_tracker_organization", "tracker.organization is required");
    }
    if (!cfg.project) {
      throw new TrackerError("missing_tracker_project", "tracker.project is required");
    }
    const base = (cfg.endpoint || "https://dev.azure.com").replace(/\/$/, "");
    const orgEndpoint = `${base}/${encodeURIComponent(cfg.organization)}`;
    const projectEndpoint = `${orgEndpoint}/${encodeURIComponent(cfg.project)}`;
    const authHeader = `Basic ${Buffer.from(":" + cfg.api_key).toString("base64")}`;
    this.ctx = {
      cfg,
      authHeader,
      orgEndpoint,
      projectEndpoint,
      rate: {},
      terminalLower: new Set(cfg.terminal_states.map((s) => s.toLowerCase())),
    };
  }

  getRateLimits(): RateLimitSnapshot {
    return { ...this.ctx.rate };
  }

  cloneUrl(issue: Issue): string | null {
    const cfg = this.ctx.cfg;
    if (!cfg.repository) return null;
    // ADO HTTPS clone: PAT goes in the userinfo. The username can be empty
    // (or anything); the PAT is what's authoritative. Use empty username
    // for symmetry with the GitHub URL shape.
    return `https://:${cfg.api_key}@dev.azure.com/${encodeURIComponent(cfg.organization)}/${encodeURIComponent(cfg.project)}/_git/${encodeURIComponent(cfg.repository)}`;
  }

  async fetchCandidateIssues(): Promise<FetchResult> {
    const wiql = buildCandidateWiql(this.ctx.cfg, {
      changedWithinDays: WIQL_LOOKBACK_DAYS,
    });
    const ids = await this.runWiql(wiql);
    if (ids.length >= WIQL_RESULT_LIMIT) {
      log.warn("ado_wiql_truncated_at_cap", {
        cap: WIQL_RESULT_LIMIT,
        hint: "narrow filters or shorten lookback",
      });
    }
    const issues = await this.fetchByIds(ids);
    return { issues, rate: this.getRateLimits() };
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<FetchResult> {
    // Issue IDs in this tracker are namespaced strings ("ado:{org}/{project}/{n}").
    // Extract the numeric tail; ignore any IDs from other trackers.
    const numeric: number[] = [];
    for (const id of ids) {
      const m = /(\d+)$/.exec(id);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n)) numeric.push(n);
      }
    }
    if (numeric.length === 0) return { issues: [], rate: this.getRateLimits() };
    const issues = await this.fetchByIds(numeric);
    return { issues, rate: this.getRateLimits() };
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<FetchResult> {
    if (stateNames.length === 0) return { issues: [], rate: this.getRateLimits() };
    // Build a one-off WIQL that overrides active_states with the given list.
    const overrideCfg: TrackerConfigAdo = {
      ...this.ctx.cfg,
      active_states: stateNames,
      label_filters: undefined,
      assignee_filter: undefined,
    };
    const wiql = buildCandidateWiql(overrideCfg, {
      changedWithinDays: WIQL_LOOKBACK_DAYS,
    });
    const ids = await this.runWiql(wiql);
    const issues = await this.fetchByIds(ids);
    return { issues, rate: this.getRateLimits() };
  }

  private async runWiql(wiql: string): Promise<number[]> {
    const url = `${this.ctx.projectEndpoint}/_apis/wit/wiql?api-version=${API_VERSION}`;
    const resp = await this.request(url, {
      method: "POST",
      body: JSON.stringify({ query: wiql }),
    });
    const data = (await this.json(resp)) as { workItems?: Array<{ id: number }> };
    return (data.workItems ?? []).map((w) => w.id).filter((n) => Number.isFinite(n));
  }

  private async fetchByIds(ids: number[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const out: Issue[] = [];
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const url = `${this.ctx.orgEndpoint}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`;
      const resp = await this.request(url, {
        method: "POST",
        body: JSON.stringify({ ids: batch, fields: FIELDS }),
      });
      const data = (await this.json(resp)) as { value?: any[] };
      for (const node of data.value ?? []) {
        out.push(this.normalize(node));
      }
    }
    return out;
  }

  private normalize(node: any): Issue {
    const cfg = this.ctx.cfg;
    const fields = (node?.fields ?? {}) as Record<string, any>;
    const id = numOrZero(fields["System.Id"] ?? node?.id);
    const title = String(fields["System.Title"] ?? "");
    const state = String(fields["System.State"] ?? "");
    const tagsRaw = String(fields["System.Tags"] ?? "");
    const labels = tagsRaw
      .split(";")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const assignedTo = fields["System.AssignedTo"];
    const assignees: string[] = [];
    if (assignedTo) {
      const login =
        typeof assignedTo === "string"
          ? assignedTo
          : assignedTo.uniqueName || assignedTo.displayName || "";
      if (login) assignees.push(String(login).toLowerCase());
    }
    const project = String(fields["System.TeamProject"] ?? cfg.project);
    const repoPart = cfg.repository ? `/${cfg.repository}` : "";
    const repository = `${cfg.organization}/${project}${repoPart}`;
    const url =
      node?._links?.html?.href ||
      `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
    const description = stripHtml(String(fields["System.Description"] ?? ""));
    const created_at = fields["System.CreatedDate"] || null;
    const updated_at = fields["System.ChangedDate"] || null;
    const priorityRaw = fields["Microsoft.VSTS.Common.Priority"];
    const priority =
      typeof priorityRaw === "number" && Number.isFinite(priorityRaw)
        ? Math.floor(priorityRaw)
        : null;
    const blocked_by = deriveBlockers(description, repository);
    const isClosed = this.ctx.terminalLower.has(state.toLowerCase());

    return {
      id: `ado:${cfg.organization}/${project}/${id}`,
      identifier: `${project}#${id}`,
      number: id,
      repository,
      title,
      description: description || null,
      priority,
      state,
      github_state: isClosed ? "closed" : "open",
      branch_name: defaultBranchName(id, title),
      url,
      labels,
      assignees,
      blocked_by,
      created_at,
      updated_at,
      pr: null, // ADO PR awareness is out of scope for v1
    };
  }

  // ---- HTTP plumbing ----

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: this.ctx.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(init.headers || {}),
        },
      });
    } catch (e: any) {
      clearTimeout(timer);
      throw new TrackerError("ado_api_request", e.message);
    }
    clearTimeout(timer);
    this.updateRateFromHeaders(resp.headers);

    if (resp.status === 429) {
      const retryAfter = resp.headers.get("retry-after");
      if (retryAfter) {
        const sec = parseInt(retryAfter, 10);
        if (Number.isFinite(sec)) this.ctx.rate.retry_after_ms = sec * 1000;
      }
      throw new TrackerError("ado_rate_limited", `HTTP 429 rate limited`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new TrackerError("ado_api_status", `HTTP ${resp.status} ${resp.statusText} — check PAT scopes`);
    }
    if (!resp.ok) {
      // Read a short error body to help diagnosis.
      let body = "";
      try { body = (await resp.text()).slice(0, 400); } catch {}
      throw new TrackerError("ado_api_status", `HTTP ${resp.status} ${resp.statusText} ${body}`);
    }
    return resp;
  }

  private async json(resp: Response): Promise<unknown> {
    try {
      return await resp.json();
    } catch (e: any) {
      throw new TrackerError("ado_unknown_payload", `JSON parse error: ${e.message}`);
    }
  }

  private updateRateFromHeaders(headers: Headers): void {
    const rem = parseInt(headers.get("x-ratelimit-remaining") || "", 10);
    if (Number.isFinite(rem)) this.ctx.rate.tstu_remaining = rem;
    const reset = parseInt(headers.get("x-ratelimit-reset") || "", 10);
    if (Number.isFinite(reset)) {
      this.ctx.rate.tstu_reset_at = new Date(reset * 1000).toISOString();
    }
    const delay = parseFloat(headers.get("x-ratelimit-delay") || "");
    if (Number.isFinite(delay) && delay > 0) {
      this.ctx.rate.server_delay_ms = Math.round(delay * 1000);
      log.warn("ado_server_delay", { delay_ms: this.ctx.rate.server_delay_ms });
    }
  }
}

// ---- helpers ----

function numOrZero(v: any): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function defaultBranchName(number: number, title: string): string {
  const slug = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 60);
  return slug ? `${number}-${slug}` : String(number);
}

/**
 * Strip HTML tags + decode the common entities so descriptions render as
 * plain text inside the Liquid prompt template. Lightweight on purpose —
 * we don't pull in a full HTML parser.
 */
function stripHtml(s: string): string {
  if (!s) return "";
  // Convert block-level closers to newlines so paragraphs survive.
  let out = s
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  // Decode the entities that show up most often in ADO descriptions.
  out = out
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    });
  // Collapse runs of blank lines.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function deriveBlockers(description: string, repoSlug: string): BlockerRef[] {
  if (!description) return [];
  const blockers: BlockerRef[] = [];
  const re = /(?:blocked\s+by|depends\s+on)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(description))) {
    const repo = m[1] || repoSlug;
    const num = m[2];
    blockers.push({ id: null, identifier: `${repo}#${num}`, state: null });
  }
  const seen = new Set<string>();
  return blockers.filter((b) => {
    const key = b.identifier || `${b.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
