// Orchestrator (Sections 7, 8, 14, 16).
//
// Single authority for scheduling state. Owns the poll tick, dispatch decisions,
// retry queue, reconciliation, and run-attempt lifecycle.

import { EventEmitter } from "node:events";
import path from "node:path";
import { log } from "../logging/logger.js";
import type {
  ClaudeTotals,
  Issue,
  RateLimitSnapshot,
  RetryEntry,
  RunningEntry,
  RuntimeEvent,
  ServiceConfig,
  WorkflowDefinition,
} from "../types.js";
import { createTracker, isRebaseCapable, TrackerError, type Tracker } from "../tracker/index.js";
import { WorkspaceManager, hookEnv, runHook, runHookBestEffort } from "../workspace/manager.js";
import { runTurn, validateAddDirs } from "../agent/claude.js";
import {
  buildContinuationPrompt,
  renderPrompt,
  PromptError,
} from "../prompt/render.js";
import { validateDispatchConfig } from "../workflow/config.js";

interface RunningInternal extends RunningEntry {
  workerAbort: AbortController;
  workerPromise: Promise<void>;
  // Mid-turn advisory totals from `assistant` events — folded into authoritative
  // totals when the `result` event arrives, then reset.
  advisory_input_tokens: number;
  advisory_output_tokens: number;
  advisory_cache_creation_input_tokens: number;
  advisory_cache_read_input_tokens: number;
  // Most recent extended-thinking block. Cleared at turn boundaries so the
  // dashboard reflects what the agent is currently reasoning about.
  latest_thinking: string | null;
  latest_thinking_at: string | null;
}

export class Orchestrator extends EventEmitter {
  // Authoritative in-memory state (Section 4.1.8)
  private running = new Map<string, RunningInternal>();
  private claimed = new Set<string>();
  private retry_attempts = new Map<string, RetryEntry & { timer: NodeJS.Timeout | null }>();
  private completed = new Set<string>();
  private claude_totals: ClaudeTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    seconds_running: 0,
    total_cost_usd: 0,
  };
  private claude_rate_limits: RateLimitSnapshot | null = null;
  private tracker_rate_limits: RateLimitSnapshot | null = null;

  private workflow: WorkflowDefinition;
  private tracker: Tracker;
  private workspaceManager: WorkspaceManager;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private effectivePollIntervalMs: number;
  private rateLimitBackoffUntilMs = 0;
  private startedAt = new Date().toISOString();

  constructor(workflow: WorkflowDefinition) {
    super();
    this.workflow = workflow;
    this.tracker = createTracker(workflow.config.tracker);
    this.workspaceManager = new WorkspaceManager(workflow.config.workspace.root);
    this.effectivePollIntervalMs = workflow.config.polling.interval_ms;
  }

  cfg(): ServiceConfig {
    return this.workflow.config;
  }

  /** Apply a hot-reloaded workflow without restarting in-flight runs. */
  applyWorkflow(workflow: WorkflowDefinition): void {
    const prevTrackerKey = trackerSignature(this.workflow.config.tracker);
    const nextTrackerKey = trackerSignature(workflow.config.tracker);
    this.workflow = workflow;
    if (prevTrackerKey !== nextTrackerKey) {
      try {
        this.tracker = createTracker(workflow.config.tracker);
      } catch (e: any) {
        log.error("tracker reload failed; keeping previous", { error: e.message });
      }
    }
    if (this.workspaceManager["root"] !== workflow.config.workspace.root) {
      this.workspaceManager = new WorkspaceManager(workflow.config.workspace.root);
    }
    this.effectivePollIntervalMs = workflow.config.polling.interval_ms;
    log.info("workflow reload applied", { source: workflow.source_path });
    this.emit("snapshot", this.snapshot());
  }

  async start(): Promise<void> {
    // Validate config; surface but do not crash
    const v = validateDispatchConfig(this.cfg());
    if (!v.ok) {
      for (const err of v.errors) log.error("startup validation failed", { error: err });
    }
    // Startup terminal cleanup (Section 8.6) — best effort
    void this.startupTerminalCleanup();
    this.scheduleTick(0);
    log.info("orchestrator started", {
      poll_interval_ms: this.effectivePollIntervalMs,
      max_concurrent_agents: this.cfg().agent.max_concurrent_agents,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const r of Array.from(this.running.values())) {
      r.workerAbort.abort("orchestrator_stop");
    }
    for (const r of this.retry_attempts.values()) {
      if (r.timer) clearTimeout(r.timer);
    }
    await Promise.all(Array.from(this.running.values()).map((r) => r.workerPromise.catch(() => {})));
    log.info("orchestrator stopped");
  }

  private scheduleTick(delayMs: number) {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    const now = Date.now();
    const waitForRateLimit = Math.max(0, this.rateLimitBackoffUntilMs - now);
    this.tickTimer = setTimeout(() => void this.tick(), Math.max(delayMs, waitForRateLimit));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.reconcileRunning();
      const v = validateDispatchConfig(this.cfg());
      if (!v.ok) {
        log.warn("dispatch validation failed", { errors: v.errors.join(",") });
        return;
      }
      // Detect parked-for-review PRs with conflicts and flip their labels so
      // they re-enter candidacy. Skipped silently when rebase.enabled = false.
      await this.reviewSweep();
      try {
        const { issues, rate } = await this.tracker.fetchCandidateIssues();
        this.tracker_rate_limits = rate;
        log.debug("poll_tick_candidates", {
          count: issues.length,
          identifiers: issues.slice(0, 10).map((i) => i.identifier).join(","),
        });
        if (issues.length === 0) {
          const t = this.cfg().tracker;
          log.info("poll_tick_no_candidates", {
            kind: t.kind,
            repository: t.repository ?? null,
            project_id: t.kind === "github" ? t.project_id ?? null : null,
            active_states: t.active_states.join("|"),
            include_labels: t.label_filters?.include?.join("|") ?? null,
            assignee_filter: t.assignee_filter?.join("|") ?? null,
          });
        }
        for (const issue of this.sortForDispatch(issues)) {
          if (!this.hasGlobalSlot()) break;
          await this.maybeDispatch(issue, null);
        }
      } catch (e: any) {
        this.handleTrackerError(e, "candidate_fetch");
      }
    } finally {
      this.emit("snapshot", this.snapshot());
      this.scheduleTick(this.effectivePollIntervalMs);
    }
  }

  private async reviewSweep(): Promise<void> {
    const rebase = this.cfg().rebase;
    if (!rebase?.enabled) return;
    // PR rebase loop is GitHub-only in v1. ADO can be added later by
    // implementing RebaseCapableTracker against the ADO PR REST API.
    if (!isRebaseCapable(this.tracker)) return;
    const cfg = this.cfg().tracker;
    if (cfg.kind !== "github" || !cfg.repository) return;
    const [owner, name] = cfg.repository.split("/", 2);
    if (!owner || !name) return;
    let parked;
    try {
      parked = await this.tracker.fetchParkedForReview();
      this.tracker_rate_limits = parked.rate;
    } catch (e: any) {
      this.handleTrackerError(e, "review_sweep");
      return;
    }
    for (const i of parked.issues) {
      if (!i.pr) continue;
      if (i.pr.mergeable === "UNKNOWN") continue; // GitHub still computing
      if (i.pr.mergeable !== "CONFLICTING") continue;
      if (this.running.has(i.id) || this.claimed.has(i.id)) continue;

      const attempt = rebaseAttemptCount(i.labels);
      try {
        if (attempt >= rebase.max_attempts) {
          await this.tracker.swapLabels(
            owner,
            name,
            i.number,
            ["needs-human"],
            ["needs-rebase", `rebase-attempt-${attempt}`],
          );
          log.warn("rebase_exhausted_escalated_to_human", {
            issue_identifier: i.identifier,
            attempts: attempt,
            pr: i.pr.number,
          });
        } else {
          const next = attempt + 1;
          const removeLabels = ["needs-review"];
          if (attempt > 0) removeLabels.push(`rebase-attempt-${attempt}`);
          await this.tracker.swapLabels(
            owner,
            name,
            i.number,
            ["needs-rebase", `rebase-attempt-${next}`],
            removeLabels,
          );
          log.info("rebase_triggered", {
            issue_identifier: i.identifier,
            attempt: next,
            pr: i.pr.number,
            mergeable: i.pr.mergeable,
          });
        }
      } catch (e: any) {
        log.warn("rebase_label_swap_failed", {
          issue_identifier: i.identifier,
          error: e?.message,
        });
      }
    }
  }

  private async reconcileRunning(): Promise<void> {
    // Stall detection
    const stallMs = this.cfg().claude.stall_timeout_ms;
    if (stallMs > 0) {
      const now = Date.now();
      for (const entry of Array.from(this.running.values())) {
        const last = entry.last_event_timestamp
          ? Date.parse(entry.last_event_timestamp)
          : Date.parse(entry.started_at);
        if (now - last > stallMs) {
          log.warn("stall_detected", {
            issue_id: entry.issue_id,
            issue_identifier: entry.identifier,
            elapsed_ms: now - last,
            session_id: entry.session_id,
          });
          entry.workerAbort.abort("stalled");
        }
      }
    }
    // Tracker state refresh
    const ids = Array.from(this.running.keys());
    if (ids.length === 0) return;
    let refreshed;
    try {
      const res = await this.tracker.fetchIssueStatesByIds(ids);
      this.tracker_rate_limits = res.rate;
      refreshed = res.issues;
    } catch (e: any) {
      this.handleTrackerError(e, "running_state_refresh");
      return;
    }
    const byId = new Map(refreshed.map((i) => [i.id, i]));
    const cfg = this.cfg();
    const termLower = new Set(cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
    const activeLower = new Set(cfg.tracker.active_states.map((s) => s.toLowerCase()));
    for (const id of ids) {
      const refreshedIssue = byId.get(id);
      const runEntry = this.running.get(id);
      if (!runEntry) continue;
      if (!refreshedIssue) continue; // missing — keep running for now
      const stateLower = (refreshedIssue.state || "").toLowerCase();
      if (refreshedIssue.github_state === "closed" || termLower.has(stateLower)) {
        log.info("reconcile_terminate_with_cleanup", {
          issue_id: id,
          issue_identifier: refreshedIssue.identifier,
          state: refreshedIssue.state,
        });
        runEntry.workerAbort.abort("terminal");
        // cleanup workspace after worker exits
        runEntry.workerPromise.finally(async () => {
          try {
            await this.workspaceManager.removeForIssue(refreshedIssue.identifier, cfg.hooks);
          } catch {}
        });
      } else if (activeLower.has(stateLower)) {
        runEntry.issue = refreshedIssue;
      } else {
        log.info("reconcile_terminate_no_cleanup", {
          issue_id: id,
          state: refreshedIssue.state,
        });
        runEntry.workerAbort.abort("non_active");
      }
    }
  }

  private async startupTerminalCleanup(): Promise<void> {
    try {
      const states = this.cfg().tracker.terminal_states;
      const { issues } = await this.tracker.fetchIssuesByStates(states);
      for (const i of issues) {
        try {
          await this.workspaceManager.removeForIssue(i.identifier, this.cfg().hooks);
        } catch {}
      }
    } catch (e: any) {
      log.warn("startup terminal cleanup failed", { error: e.message });
    }
  }

  private sortForDispatch(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const ap = a.priority ?? Number.POSITIVE_INFINITY;
      const bp = b.priority ?? Number.POSITIVE_INFINITY;
      if (ap !== bp) return ap - bp;
      const ad = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
      const bd = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return a.identifier.localeCompare(b.identifier);
    });
  }

  private hasGlobalSlot(): boolean {
    return this.running.size < this.cfg().agent.max_concurrent_agents;
  }

  private hasStateSlot(state: string): boolean {
    const m = this.cfg().agent.max_concurrent_agents_by_state[state.toLowerCase()];
    if (m == null) return true;
    let inState = 0;
    for (const r of this.running.values()) {
      if ((r.issue.state || "").toLowerCase() === state.toLowerCase()) inState++;
    }
    return inState < m;
  }

  private async maybeDispatch(issue: Issue, attempt: number | null): Promise<void> {
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return;
    if (!this.hasGlobalSlot() || !this.hasStateSlot(issue.state)) return;
    if (!issue.id || !issue.identifier || !issue.title || !issue.state || !issue.repository) return;
    if (issue.github_state !== "open") return;

    const cfg = this.cfg();
    const activeLower = cfg.tracker.active_states.map((s) => s.toLowerCase());
    const stateLower = issue.state.toLowerCase();
    if (!activeLower.includes(stateLower)) return;

    // Blocker rule for first active state
    if (activeLower[0] === stateLower) {
      const cfgTerm = new Set(cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
      const nonTerminalBlocker = (issue.blocked_by || []).some(
        (b) => !b.state || !cfgTerm.has((b.state || "").toLowerCase()),
      );
      if (issue.blocked_by && issue.blocked_by.length > 0 && nonTerminalBlocker) {
        log.debug("blocked_by_blocker; skip", { issue_identifier: issue.identifier });
        return;
      }
    }

    // add_dir safety
    const errs = validateAddDirs(cfg.claude.add_dir, cfg.workspace.root);
    if (errs.length) {
      log.error("claude.add_dir invalid; aborting dispatch", { errors: errs.join(";") });
      return;
    }

    await this.dispatch(issue, attempt);
  }

  private async dispatch(issue: Issue, attempt: number | null): Promise<void> {
    this.claimed.add(issue.id);
    // Remove from retry queue if present
    const retry = this.retry_attempts.get(issue.id);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retry_attempts.delete(issue.id);

    const abort = new AbortController();
    const entry: RunningInternal = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      workspace_path: "",
      status: "PreparingWorkspace",
      retry_attempt: attempt,
      started_at: new Date().toISOString(),
      session_id: null,
      thread_id: null,
      turn_id: null,
      claude_pid: null,
      last_event: null,
      last_event_timestamp: null,
      last_message: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 0,
      total_cost_usd: 0,
      events: [],
      workerAbort: abort,
      workerPromise: Promise.resolve(),
      advisory_input_tokens: 0,
      advisory_output_tokens: 0,
      advisory_cache_creation_input_tokens: 0,
      advisory_cache_read_input_tokens: 0,
      latest_thinking: null,
      latest_thinking_at: null,
    };
    this.running.set(issue.id, entry);
    log.info("dispatch_started", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      repository: issue.repository,
      attempt,
    });
    this.emit("snapshot", this.snapshot());

    entry.workerPromise = this.runAttempt(entry, attempt)
      .catch((e: any) => {
        log.error("worker_unhandled", { error: e?.message, issue_id: issue.id });
      })
      .finally(() => {
        this.afterWorkerExit(entry);
      });
  }

  private async runAttempt(entry: RunningInternal, attempt: number | null): Promise<void> {
    const cfg = this.cfg();
    let workerExitReason: "normal" | { error: string } = "normal";
    try {
      // Workspace creation
      entry.status = "PreparingWorkspace";
      const ws = await this.workspaceManager.createForIssue(entry.identifier);
      entry.workspace_path = ws.path;
      // Tracker provides the authenticated clone URL (contains a secret —
      // never log full env). Used by WORKFLOW.md's `after_create` hook.
      const repoUrl = this.tracker.cloneUrl(entry.issue);
      const env = hookEnv(entry.issue, ws.path, attempt, repoUrl);

      if (ws.created_now && cfg.hooks.after_create) {
        const r = await runHook(
          "after_create",
          cfg.hooks.after_create,
          ws.path,
          env,
          cfg.hooks.timeout_ms,
        );
        if (!r.ok) {
          workerExitReason = { error: `after_create hook failed: ${r.error}` };
          return;
        }
      }
      if (cfg.hooks.before_run) {
        const r = await runHook(
          "before_run",
          cfg.hooks.before_run,
          ws.path,
          env,
          cfg.hooks.timeout_ms,
        );
        if (!r.ok) {
          workerExitReason = { error: `before_run hook failed: ${r.error}` };
          return;
        }
      }

      // Per-turn loop
      let turnNumber = 1;
      let sessionId: string | null = null;
      const maxTurns = cfg.agent.max_turns;
      while (true) {
        if (entry.workerAbort.signal.aborted) {
          workerExitReason = { error: `cancelled: ${entry.workerAbort.signal.reason}` };
          return;
        }
        entry.status = "BuildingPrompt";
        entry.turn_count = turnNumber;
        let prompt: string;
        try {
          prompt =
            sessionId == null
              ? await renderPrompt(this.workflow.prompt_template, {
                  issue: entry.issue,
                  attempt,
                })
              : buildContinuationPrompt(
                  cfg.claude.continuation_prompt,
                  entry.issue,
                  attempt,
                );
        } catch (e: any) {
          if (e instanceof PromptError) {
            workerExitReason = { error: `${e.code}: ${e.message}` };
            return;
          }
          throw e;
        }
        entry.status = "LaunchingClaude";

        const result = await runTurn({
          cwd: entry.workspace_path,
          prompt,
          resumeSessionId: sessionId,
          turnNumber,
          config: cfg.claude,
          cancelSignal: entry.workerAbort.signal,
          onEvent: (e) => this.absorbAgentEvent(entry, e),
        });
        entry.status = "StreamingTurn";
        if (result.session_id) {
          sessionId = result.session_id;
          entry.session_id = sessionId;
          entry.thread_id = sessionId;
          entry.turn_id = `${sessionId}-${turnNumber}`;
        }
        // Apply usage deltas (per-turn result.usage = per-turn delta per spec 13.5)
        if (result.usage) {
          this.accumulateUsage(entry, result.usage);
        }
        if (!result.ok) {
          workerExitReason = { error: result.error || result.result_subtype || "turn_failed" };
          return;
        }

        // After successful turn: refresh issue state, possibly continue
        try {
          const { issues: refreshed } = await this.tracker.fetchIssueStatesByIds([entry.issue_id]);
          if (refreshed.length === 0) {
            return; // issue vanished; exit normally
          }
          entry.issue = refreshed[0];
          const stateLower = (entry.issue.state || "").toLowerCase();
          const term = new Set(cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
          const active = new Set(cfg.tracker.active_states.map((s) => s.toLowerCase()));
          if (entry.issue.github_state === "closed" || term.has(stateLower)) return;
          if (!active.has(stateLower)) return;
        } catch (e: any) {
          workerExitReason = { error: `issue_state_refresh: ${e.message}` };
          return;
        }
        if (turnNumber >= maxTurns) return;
        turnNumber++;
      }
    } catch (e: any) {
      workerExitReason = { error: e?.message || "worker exception" };
    } finally {
      // after_run hook best effort
      if (entry.workspace_path && this.cfg().hooks.after_run) {
        await runHookBestEffort(
          "after_run",
          this.cfg().hooks.after_run as string,
          entry.workspace_path,
          hookEnv(entry.issue, entry.workspace_path, attempt, this.tracker.cloneUrl(entry.issue)),
          this.cfg().hooks.timeout_ms,
        );
      }
      entry.status = workerExitReason === "normal" ? "Succeeded" : "Failed";
      if (workerExitReason !== "normal") entry.error = workerExitReason.error;
    }
  }

  private absorbAgentEvent(entry: RunningInternal, event: RuntimeEvent): void {
    entry.last_event = event.event;
    entry.last_event_timestamp = event.timestamp;
    // Advance status as events arrive so the UI reflects reality.
    switch (event.event) {
      case "session_started":
        entry.status = "StreamingTurn";
        // session_started carries the session_id in the payload; capture it
        // immediately so the UI doesn't show null until the turn completes.
        if (event.payload?.session_id && !entry.session_id) {
          entry.session_id = event.payload.session_id;
          entry.thread_id = event.payload.session_id;
          entry.turn_id = `${event.payload.session_id}-${entry.turn_count || 1}`;
        }
        break;
      case "startup_failed":
        entry.status = "Failed";
        break;
      case "turn_completed":
        entry.status = "Finishing";
        break;
      case "turn_failed":
      case "turn_ended_with_error":
        entry.status = "Failed";
        break;
      case "turn_cancelled":
        entry.status = "CanceledByReconciliation";
        break;
    }
    if (event.payload) {
      if (event.event === "assistant_text") {
        entry.last_message = String(event.payload.text || "").slice(0, 240);
      } else if (event.event === "assistant_thinking") {
        const txt = String(event.payload.text || "");
        entry.latest_thinking = txt;
        entry.latest_thinking_at = event.timestamp;
        entry.last_message = `thinking · ${firstLine(txt).slice(0, 200)}`;
      } else if (event.event === "tool_use") {
        entry.last_message = `tool:${event.payload.name}`;
      } else if (event.event === "tool_result") {
        entry.last_message = `tool_result:${event.payload.ok ? "ok" : "error"}`;
      } else if (event.event === "session_started") {
        entry.last_message = `session ${event.payload.session_id?.slice(0, 8)} model ${event.payload.model}`;
      } else {
        entry.last_message = event.event;
      }
    }
    // Clear stale thinking at turn boundaries so the dashboard doesn't show
    // last turn's reasoning during the next turn.
    if (event.event === "turn_completed" || event.event === "turn_failed" ||
        event.event === "turn_cancelled" || event.event === "turn_ended_with_error") {
      entry.latest_thinking = null;
      entry.latest_thinking_at = null;
    }
    if (event.claude_pid) entry.claude_pid = event.claude_pid;
    if (event.usage) {
      this.accumulateUsageAdvisory(entry, event.usage);
    }
    // Cap stored events per session
    entry.events.push(event);
    if (entry.events.length > 200) entry.events.splice(0, entry.events.length - 200);
    this.emit("agent_event", { issue_id: entry.issue_id, event });
  }

  private accumulateUsage(entry: RunningInternal, u: NonNullable<RuntimeEvent["usage"]>) {
    const i = u.input_tokens ?? 0;
    const o = u.output_tokens ?? 0;
    const cc = u.cache_creation_input_tokens ?? 0;
    const cr = u.cache_read_input_tokens ?? 0;
    const cost = u.total_cost_usd ?? 0;
    entry.input_tokens += i;
    entry.output_tokens += o;
    entry.cache_creation_input_tokens += cc;
    entry.cache_read_input_tokens += cr;
    entry.total_tokens = entry.input_tokens + entry.output_tokens;
    entry.total_cost_usd += cost;
    entry.last_reported_input_tokens = i;
    entry.last_reported_output_tokens = o;
    entry.last_reported_total_tokens = i + o;
    // Authoritative result has arrived — the advisory for this turn is folded in.
    entry.advisory_input_tokens = 0;
    entry.advisory_output_tokens = 0;
    entry.advisory_cache_creation_input_tokens = 0;
    entry.advisory_cache_read_input_tokens = 0;
    this.claude_totals.input_tokens += i;
    this.claude_totals.output_tokens += o;
    this.claude_totals.cache_creation_input_tokens += cc;
    this.claude_totals.cache_read_input_tokens += cr;
    this.claude_totals.total_tokens =
      this.claude_totals.input_tokens + this.claude_totals.output_tokens;
    this.claude_totals.total_cost_usd += cost;
  }

  // Advisory usage from `assistant` messages reports cumulative tokens within the
  // current turn. Use max() so we never go backwards if events arrive out of order;
  // these values are reset to 0 when the authoritative `result` lands.
  private accumulateUsageAdvisory(entry: RunningInternal, u: NonNullable<RuntimeEvent["usage"]>) {
    entry.advisory_input_tokens = Math.max(entry.advisory_input_tokens, u.input_tokens ?? 0);
    entry.advisory_output_tokens = Math.max(entry.advisory_output_tokens, u.output_tokens ?? 0);
    entry.advisory_cache_creation_input_tokens = Math.max(
      entry.advisory_cache_creation_input_tokens,
      u.cache_creation_input_tokens ?? 0,
    );
    entry.advisory_cache_read_input_tokens = Math.max(
      entry.advisory_cache_read_input_tokens,
      u.cache_read_input_tokens ?? 0,
    );
  }

  private afterWorkerExit(entry: RunningInternal): void {
    const wasRunning = this.running.delete(entry.issue_id);
    this.claimed.delete(entry.issue_id);
    if (!wasRunning) return;
    const runtimeSec = (Date.now() - Date.parse(entry.started_at)) / 1000;
    this.claude_totals.seconds_running += runtimeSec;
    const cfg = this.cfg();
    const stateLower = (entry.issue.state || "").toLowerCase();
    const termLower = new Set(cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
    const isTerminal = entry.issue.github_state === "closed" || termLower.has(stateLower);
    if (isTerminal) {
      if (entry.status === "Succeeded") this.completed.add(entry.issue_id);
      void this.workspaceManager
        .removeForIssue(entry.identifier, cfg.hooks)
        .then(() =>
          log.info("workspace_removed", {
            issue_id: entry.issue_id,
            issue_identifier: entry.identifier,
            state: entry.issue.state,
          }),
        )
        .catch((e: any) =>
          log.warn("workspace_remove_failed", {
            issue_id: entry.issue_id,
            issue_identifier: entry.identifier,
            error: e?.message,
          }),
        );
    } else if (entry.status === "Succeeded") {
      this.completed.add(entry.issue_id);
      // Continuation retry after ~1s
      this.scheduleRetry(
        entry.issue_id,
        entry.identifier,
        1,
        1000,
        null,
      );
    } else {
      const attempt = nextAttempt(entry.retry_attempt);
      const delay = Math.min(10000 * Math.pow(2, attempt - 1), cfg.agent.max_retry_backoff_ms);
      this.scheduleRetry(
        entry.issue_id,
        entry.identifier,
        attempt,
        delay,
        entry.error || "worker_exit",
      );
    }
    log.info("worker_exited", {
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      status: entry.status,
      runtime_seconds: runtimeSec.toFixed(1),
      session_id: entry.session_id,
      total_cost_usd: entry.total_cost_usd.toFixed(4),
      error: entry.error ?? undefined,
    });
    this.emit("snapshot", this.snapshot());
  }

  private scheduleRetry(
    issue_id: string,
    identifier: string,
    attempt: number,
    delay_ms: number,
    error: string | null,
  ): void {
    const existing = this.retry_attempts.get(issue_id);
    if (existing?.timer) clearTimeout(existing.timer);
    const due_at_ms = Date.now() + delay_ms;
    const entry: RetryEntry & { timer: NodeJS.Timeout | null } = {
      issue_id,
      identifier,
      attempt,
      due_at_ms,
      due_at: new Date(due_at_ms).toISOString(),
      error,
      timer: null,
    };
    this.claimed.add(issue_id);
    entry.timer = setTimeout(() => void this.onRetryTimer(issue_id), delay_ms);
    this.retry_attempts.set(issue_id, entry);
  }

  private async onRetryTimer(issue_id: string): Promise<void> {
    const entry = this.retry_attempts.get(issue_id);
    if (!entry) return;
    this.retry_attempts.delete(issue_id);
    let candidates;
    try {
      const r = await this.tracker.fetchCandidateIssues();
      this.tracker_rate_limits = r.rate;
      candidates = r.issues;
    } catch (e: any) {
      this.handleTrackerError(e, "retry_poll");
      this.scheduleRetry(
        issue_id,
        entry.identifier,
        entry.attempt + 1,
        Math.min(10000 * Math.pow(2, entry.attempt), this.cfg().agent.max_retry_backoff_ms),
        "retry poll failed",
      );
      return;
    }
    const issue = candidates.find((i) => i.id === issue_id);
    if (!issue) {
      this.claimed.delete(issue_id);
      return;
    }
    if (!this.hasGlobalSlot() || !this.hasStateSlot(issue.state)) {
      this.scheduleRetry(
        issue_id,
        issue.identifier,
        entry.attempt + 1,
        Math.min(10000 * Math.pow(2, entry.attempt), this.cfg().agent.max_retry_backoff_ms),
        "no available orchestrator slots",
      );
      return;
    }
    await this.dispatch(issue, entry.attempt);
  }

  private handleTrackerError(e: any, label: string) {
    if (e instanceof TrackerError) {
      log.warn("tracker_error", { code: e.code, label, message: e.message });
      const isRateLimited =
        e.code === "github_rate_limited" ||
        e.code === "github_secondary_rate_limit" ||
        e.code === "ado_rate_limited";
      if (isRateLimited) {
        const cap = Math.min(this.effectivePollIntervalMs * 4, this.cfg().agent.max_retry_backoff_ms);
        this.rateLimitBackoffUntilMs = Date.now() + cap;
      }
    } else {
      log.error("tracker_unknown_error", { label, error: e?.message });
    }
  }

  snapshot(): {
    generated_at: string;
    started_at: string;
    counts: { running: number; retrying: number };
    running: any[];
    retrying: any[];
    claude_totals: ClaudeTotals;
    tracker_rate_limits: RateLimitSnapshot | null;
    claude_rate_limits: RateLimitSnapshot | null;
    workflow: {
      source: string;
      tracker_kind: string;
      repository: string | null;
      project_id: string | null;
      poll_interval_ms: number;
      max_concurrent_agents: number;
    };
  } {
    const running = Array.from(this.running.values()).map((r) => {
      const liveIn = r.input_tokens + r.advisory_input_tokens;
      const liveOut = r.output_tokens + r.advisory_output_tokens;
      const liveCc = r.cache_creation_input_tokens + r.advisory_cache_creation_input_tokens;
      const liveCr = r.cache_read_input_tokens + r.advisory_cache_read_input_tokens;
      const live = r.advisory_input_tokens + r.advisory_output_tokens > 0;
      return {
        issue_id: r.issue_id,
        issue_identifier: r.identifier,
        repository: r.issue.repository,
        title: r.issue.title,
        url: r.issue.url,
        state: r.issue.state,
        priority: r.issue.priority,
        labels: r.issue.labels,
        assignees: r.issue.assignees,
        session_id: r.session_id,
        claude_pid: r.claude_pid,
        turn_count: r.turn_count,
        status: r.status,
        last_event: r.last_event,
        last_message: r.last_message,
        started_at: r.started_at,
        last_event_at: r.last_event_timestamp,
        tokens: {
          input_tokens: liveIn,
          output_tokens: liveOut,
          cache_creation_input_tokens: liveCc,
          cache_read_input_tokens: liveCr,
          // Headline total includes cache reads + cache writes so the displayed
          // number reflects the actual prompt size Claude processed, not just
          // the (typically tiny) non-cached delta.
          total_tokens: liveIn + liveOut + liveCc + liveCr,
          live, // true while mid-turn advisory is in effect
        },
        cost_usd: r.total_cost_usd,
        events: r.events.slice(-30),
        workspace_path: r.workspace_path,
        latest_thinking: r.latest_thinking,
        latest_thinking_at: r.latest_thinking_at,
        pr: r.issue.pr ?? null,
      };
    });
    const retrying = Array.from(this.retry_attempts.values()).map((r) => ({
      issue_id: r.issue_id,
      issue_identifier: r.identifier,
      attempt: r.attempt,
      due_at: r.due_at,
      error: r.error,
    }));
    return {
      generated_at: new Date().toISOString(),
      started_at: this.startedAt,
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      claude_totals: this.claude_totals,
      tracker_rate_limits: this.tracker_rate_limits,
      claude_rate_limits: this.claude_rate_limits,
      workflow: (() => {
        const t = this.cfg().tracker;
        return {
          source: this.workflow.source_path,
          tracker_kind: t.kind,
          repository: t.repository ?? null,
          project_id: t.kind === "github" ? t.project_id ?? null : null,
          poll_interval_ms: this.effectivePollIntervalMs,
          max_concurrent_agents: this.cfg().agent.max_concurrent_agents,
        };
      })(),
    };
  }

  findRunningByIdentifier(identifier: string) {
    for (const r of this.running.values()) {
      if (r.identifier === identifier) return r;
    }
    return null;
  }

  async forceRefresh(): Promise<void> {
    // Cancel the current scheduled tick and run immediately
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    await this.tick();
  }
}

function trackerSignature(t: ServiceConfig["tracker"]): string {
  if (t.kind === "github") {
    return JSON.stringify({
      kind: t.kind,
      endpoint: t.endpoint,
      repository: t.repository,
      project_id: t.project_id,
      api_key_present: !!t.api_key,
    });
  }
  // azuredevops
  return JSON.stringify({
    kind: t.kind,
    endpoint: t.endpoint,
    organization: t.organization,
    project: t.project,
    repository: t.repository,
    api_key_present: !!t.api_key,
  });
}

function nextAttempt(prev: number | null): number {
  if (prev == null) return 1;
  return prev + 1;
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i === -1 ? s : s.slice(0, i)).trim();
}

function rebaseAttemptCount(labels: string[]): number {
  let max = 0;
  for (const l of labels) {
    const m = /^rebase-attempt-(\d+)$/.exec(l);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}
