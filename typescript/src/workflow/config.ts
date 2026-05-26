// Resolves raw workflow front matter into a typed ServiceConfig (Section 6).

import os from "node:os";
import path from "node:path";
import { expandHome, resolveVar } from "../util/path.js";
import type {
  AgentConfig,
  ClaudeConfig,
  HooksConfig,
  PollingConfig,
  RebaseConfig,
  ServiceConfig,
  TrackerConfig,
  TrackerConfigAdo,
  TrackerConfigGitHub,
  WorkspaceConfig,
} from "../types.js";

export class ConfigError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function asObject(v: any, fallback: Record<string, any> = {}): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
}

function asStringArray(v: any): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x) => typeof x === "string");
}

function asPositiveInt(v: any, dflt: number): number {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function asBool(v: any, dflt: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return dflt;
}

export function resolveServiceConfig(raw: Record<string, any>, workflowPath: string): ServiceConfig {
  const tracker = resolveTracker(asObject(raw.tracker));
  const polling = resolvePolling(asObject(raw.polling));
  const workspace = resolveWorkspace(asObject(raw.workspace), workflowPath);
  const hooks = resolveHooks(asObject(raw.hooks));
  const agent = resolveAgent(asObject(raw.agent));
  const claude = resolveClaude(asObject(raw.claude), workflowPath);
  const rebase = resolveRebase(asObject(raw.rebase));
  return { tracker, polling, workspace, hooks, agent, claude, rebase };
}

function resolveRebase(raw: Record<string, any>): RebaseConfig {
  return {
    enabled: asBool(raw.enabled, false),
    max_attempts: asPositiveInt(raw.max_attempts, 2),
  };
}

function resolveTracker(raw: Record<string, any>): TrackerConfig {
  const kind = (raw.kind || "github") as string;
  if (kind === "azuredevops") return resolveAdoTracker(raw);
  if (kind === "github") return resolveGitHubTracker(raw);
  throw new ConfigError("unsupported_tracker_kind", `tracker.kind=${kind} not supported (expected: github | azuredevops)`);
}

function resolveGitHubTracker(raw: Record<string, any>): TrackerConfigGitHub {
  const endpoint = (raw.endpoint || "https://api.github.com") as string;

  const apiKeyValue = raw.api_key ? resolveVar(String(raw.api_key)) : null;
  const api_key = apiKeyValue ?? undefined;

  let app_credentials: TrackerConfigGitHub["app_credentials"] | undefined;
  if (raw.app_credentials && typeof raw.app_credentials === "object") {
    const ac = raw.app_credentials as Record<string, any>;
    app_credentials = {
      app_id: typeof ac.app_id === "string" ? resolveVar(ac.app_id) ?? undefined : ac.app_id,
      installation_id:
        typeof ac.installation_id === "string"
          ? resolveVar(ac.installation_id) ?? undefined
          : ac.installation_id,
      private_key:
        typeof ac.private_key === "string"
          ? resolveVar(ac.private_key) ?? ac.private_key
          : undefined,
    };
  }

  const project_id = raw.project_id ? String(raw.project_id) : undefined;

  const state_source =
    (raw.state_source as TrackerConfigGitHub["state_source"]) ||
    (project_id ? "project" : "labels");

  const defaultActive =
    state_source === "closed_flag" ? ["Open"] : ["Todo", "In Progress"];

  const defaultTerminal =
    state_source === "closed_flag"
      ? ["Closed"]
      : state_source === "labels"
      ? ["Done", "Closed", "Cancelled", "Canceled", "Duplicate", "Wont Fix", "Won't Fix"]
      : ["Done", "Closed", "Cancelled", "Canceled", "Duplicate", "Wont Fix"];

  return {
    kind: "github",
    endpoint,
    api_key,
    app_credentials,
    repository: raw.repository ? String(raw.repository) : undefined,
    project_id,
    state_source,
    state_label_prefix: raw.state_label_prefix || "status:",
    state_field: raw.state_field || "Status",
    priority_source: (raw.priority_source as TrackerConfigGitHub["priority_source"]) || "labels",
    priority_label_pattern: raw.priority_label_pattern || "^p(\\d)$",
    priority_field: raw.priority_field || "Priority",
    assignee_filter: asStringArray(raw.assignee_filter),
    label_filters:
      raw.label_filters && typeof raw.label_filters === "object"
        ? {
            include: asStringArray(raw.label_filters.include),
            exclude: asStringArray(raw.label_filters.exclude),
          }
        : undefined,
    active_states: asStringArray(raw.active_states) ?? defaultActive,
    terminal_states: asStringArray(raw.terminal_states) ?? defaultTerminal,
  };
}

function resolveAdoTracker(raw: Record<string, any>): TrackerConfigAdo {
  const endpoint = (raw.endpoint || "https://dev.azure.com") as string;
  const apiKeyValue = raw.api_key ? resolveVar(String(raw.api_key)) : null;
  const api_key = apiKeyValue ?? "";
  // Active/terminal defaults match the Agile process template — most common.
  const defaultActive = ["New", "Active"];
  const defaultTerminal = ["Resolved", "Closed", "Removed"];
  return {
    kind: "azuredevops",
    endpoint,
    api_key,
    organization: raw.organization ? String(raw.organization) : "",
    project: raw.project ? String(raw.project) : "",
    repository: raw.repository ? String(raw.repository) : undefined,
    work_item_types: asStringArray(raw.work_item_types),
    area_path: raw.area_path ? String(raw.area_path) : undefined,
    iteration_path: raw.iteration_path ? String(raw.iteration_path) : undefined,
    assignee_filter: asStringArray(raw.assignee_filter),
    label_filters:
      raw.label_filters && typeof raw.label_filters === "object"
        ? {
            include: asStringArray(raw.label_filters.include),
            exclude: asStringArray(raw.label_filters.exclude),
          }
        : undefined,
    active_states: asStringArray(raw.active_states) ?? defaultActive,
    terminal_states: asStringArray(raw.terminal_states) ?? defaultTerminal,
  };
}

function resolvePolling(raw: Record<string, any>): PollingConfig {
  return {
    interval_ms: asPositiveInt(raw.interval_ms, 30000),
    use_etag: asBool(raw.use_etag, true),
  };
}

function resolveWorkspace(raw: Record<string, any>, workflowPath: string): WorkspaceConfig {
  const dflt = path.join(os.tmpdir(), "symphony_workspaces");
  let root = raw.root ? String(raw.root) : dflt;
  // env-var indirection only if the value is a $VAR token
  if (/^\$[A-Z_][A-Z0-9_]*$/i.test(root)) {
    const resolved = resolveVar(root);
    root = resolved ?? dflt;
  }
  root = expandHome(root);
  if (!path.isAbsolute(root)) {
    root = path.resolve(path.dirname(workflowPath), root);
  }
  return { root };
}

function resolveHooks(raw: Record<string, any>): HooksConfig {
  return {
    after_create: typeof raw.after_create === "string" ? raw.after_create : undefined,
    before_run: typeof raw.before_run === "string" ? raw.before_run : undefined,
    after_run: typeof raw.after_run === "string" ? raw.after_run : undefined,
    before_remove: typeof raw.before_remove === "string" ? raw.before_remove : undefined,
    timeout_ms: asPositiveInt(raw.timeout_ms, 60000),
  };
}

function resolveAgent(raw: Record<string, any>): AgentConfig {
  const stateMapRaw = (raw.max_concurrent_agents_by_state || {}) as Record<string, any>;
  const map: Record<string, number> = {};
  for (const [k, v] of Object.entries(stateMapRaw)) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) {
      map[k.toLowerCase()] = Math.floor(n);
    }
  }
  return {
    max_concurrent_agents: asPositiveInt(raw.max_concurrent_agents, 10),
    max_turns: asPositiveInt(raw.max_turns, 20),
    max_retry_backoff_ms: asPositiveInt(raw.max_retry_backoff_ms, 300000),
    max_concurrent_agents_by_state: map,
  };
}

function resolveClaude(raw: Record<string, any>, workflowPath: string): ClaudeConfig {
  function resolvePath(p?: string): string | undefined {
    if (!p) return undefined;
    let v = p;
    if (/^\$[A-Z_][A-Z0-9_]*$/i.test(v)) {
      const resolved = resolveVar(v);
      if (!resolved) return undefined;
      v = resolved;
    }
    v = expandHome(v);
    if (!path.isAbsolute(v)) v = path.resolve(path.dirname(workflowPath), v);
    return v;
  }
  return {
    command: raw.command ? String(raw.command) : "claude",
    model: raw.model ? String(raw.model) : "claude-sonnet-4-6",
    permission_mode:
      (raw.permission_mode as ClaudeConfig["permission_mode"]) || "bypassPermissions",
    allowed_tools: asStringArray(raw.allowed_tools),
    disallowed_tools: asStringArray(raw.disallowed_tools),
    mcp_config: resolvePath(raw.mcp_config),
    add_dir: Array.isArray(raw.add_dir)
      ? raw.add_dir.map((p: string) => resolvePath(p) ?? p).filter(Boolean)
      : undefined,
    claude_settings: resolvePath(raw.claude_settings),
    turn_timeout_ms: asPositiveInt(raw.turn_timeout_ms, 3600000),
    read_timeout_ms: asPositiveInt(raw.read_timeout_ms, 5000),
    stall_timeout_ms:
      typeof raw.stall_timeout_ms === "number" && raw.stall_timeout_ms <= 0
        ? 0
        : asPositiveInt(raw.stall_timeout_ms, 300000),
    extra_args: asStringArray(raw.extra_args),
    continuation_prompt: raw.continuation_prompt
      ? String(raw.continuation_prompt)
      : undefined,
  };
}

// Section 6.3 — Dispatch preflight validation
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateDispatchConfig(cfg: ServiceConfig): ValidationResult {
  const errors: string[] = [];
  const t = cfg.tracker;
  if (!t.kind) errors.push("tracker.kind missing");
  if (t.kind !== "github" && t.kind !== "azuredevops") {
    errors.push(`unsupported tracker kind: ${(t as any).kind}`);
  }
  if (t.kind === "github") {
    const hasApiKey = !!t.api_key;
    const hasApp =
      !!t.app_credentials &&
      !!t.app_credentials.app_id &&
      !!t.app_credentials.installation_id &&
      !!t.app_credentials.private_key;
    if (!hasApiKey && !hasApp) errors.push("missing_tracker_api_key");
    if (!t.repository && !t.project_id) errors.push("missing_tracker_repository_or_project");
  } else if (t.kind === "azuredevops") {
    if (!t.api_key) errors.push("missing_tracker_api_key");
    if (!t.organization) errors.push("missing_tracker_organization");
    if (!t.project) errors.push("missing_tracker_project");
  }
  if (!cfg.claude.command) errors.push("claude.command missing");
  return { ok: errors.length === 0, errors };
}
