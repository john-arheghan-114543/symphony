// Claude Code subprocess runner (Section 10). Per-turn invocation via bash -lc,
// stream-json line parser, --resume for continuation turns.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import type { ClaudeConfig, RuntimeEvent } from "../types.js";
import { log } from "../logging/logger.js";
import { resolveBashPath } from "../workspace/manager.js";
import { treeKill } from "../util/process.js";

export type ClaudeRunnerEvent = RuntimeEvent;

export interface TurnContext {
  cwd: string;
  prompt: string;
  resumeSessionId: string | null;
  turnNumber: number;
  config: ClaudeConfig;
  onEvent: (e: ClaudeRunnerEvent) => void;
  cancelSignal?: AbortSignal;
}

export interface TurnResult {
  ok: boolean;
  session_id: string | null;
  error?: string;
  exit_code: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    total_cost_usd?: number;
  };
  duration_ms: number;
  result_subtype?: string;
}

const MAX_LINE_BYTES = 10 * 1024 * 1024; // 10 MB

export async function runTurn(ctx: TurnContext): Promise<TurnResult> {
  // Safety invariant: ensure cwd is an existing directory under the configured workspace
  let stat;
  try {
    stat = await fs.stat(ctx.cwd);
  } catch (e: any) {
    return {
      ok: false,
      session_id: ctx.resumeSessionId,
      error: `invalid_workspace_cwd: ${e.message}`,
      exit_code: null,
      duration_ms: 0,
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      session_id: ctx.resumeSessionId,
      error: "invalid_workspace_cwd: not a directory",
      exit_code: null,
      duration_ms: 0,
    };
  }

  // mcp_config path readability check
  if (ctx.config.mcp_config) {
    try {
      await fs.access(ctx.config.mcp_config, fs.constants.R_OK);
    } catch {
      return {
        ok: false,
        session_id: ctx.resumeSessionId,
        error: `mcp_config_missing: ${ctx.config.mcp_config}`,
        exit_code: null,
        duration_ms: 0,
      };
    }
  }

  const args = buildArgs(ctx);
  const escapedCommand = `${ctx.config.command} ${args.map(shellQuote).join(" ")}`;
  const startMs = Date.now();

  log.debug("claude launching", { cwd: ctx.cwd, turn: ctx.turnNumber });
  const child: ChildProcess = spawn(resolveBashPath(), ["-lc", escapedCommand], {
    cwd: ctx.cwd,
    env: {
      ...process.env,
      CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pid = child.pid ?? null;
  const pidStr = pid != null ? String(pid) : null;

  let sessionId: string | null = ctx.resumeSessionId;
  let resultSubtype: string | undefined;
  let usage: TurnResult["usage"];
  let firstEventSeen = false;
  let initTimer: NodeJS.Timeout | null = null;
  let turnTimer: NodeJS.Timeout | null = null;
  let stalled = false;
  let cancelled = false;
  let stderr = "";

  const emit = (event: string, payload?: any, u?: TurnResult["usage"]) => {
    ctx.onEvent({
      event,
      timestamp: new Date().toISOString(),
      claude_pid: pidStr,
      payload,
      usage: u,
    });
  };

  const cleanup = () => {
    if (initTimer) {
      clearTimeout(initTimer);
      initTimer = null;
    }
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = null;
    }
  };

  const killSubtree = (sig: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
    if (child.pid && !child.killed) {
      treeKill(child.pid, sig);
    }
  };

  // startup read timeout
  initTimer = setTimeout(() => {
    if (!firstEventSeen) {
      log.warn("claude startup timeout", { read_timeout_ms: ctx.config.read_timeout_ms });
      emit("startup_failed", { reason: "startup_timeout" });
      killSubtree("SIGTERM");
      setTimeout(() => killSubtree("SIGKILL"), 2000);
    }
  }, ctx.config.read_timeout_ms);

  // total turn timeout
  turnTimer = setTimeout(() => {
    log.warn("claude turn timeout", { turn_timeout_ms: ctx.config.turn_timeout_ms });
    emit("turn_failed", { reason: "turn_timeout" });
    killSubtree("SIGTERM");
    setTimeout(() => killSubtree("SIGKILL"), 2000);
  }, ctx.config.turn_timeout_ms);

  if (ctx.cancelSignal) {
    ctx.cancelSignal.addEventListener("abort", () => {
      cancelled = true;
      emit("turn_cancelled", { reason: ctx.cancelSignal?.reason ?? "reconciliation" });
      killSubtree("SIGTERM");
      setTimeout(() => killSubtree("SIGKILL"), 2000);
    });
  }

  // Line-buffered stdout parser
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE_BYTES) {
      log.warn("claude stdout line buffer overflow; dropping", { size: buf.length });
      buf = "";
      return;
    }
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trimEnd();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      processLine(line);
    }
  });

  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
  });

  function processLine(line: string) {
    firstEventSeen = true;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      emit("malformed", { line: line.slice(0, 500) });
      return;
    }
    const type = msg?.type;
    if (type === "system" && msg?.subtype === "init") {
      sessionId = msg?.session_id || sessionId;
      emit("session_started", {
        session_id: sessionId,
        model: msg?.model,
        tools: msg?.tools,
        cwd: msg?.cwd,
      });
      return;
    }
    if (type === "assistant") {
      const content = msg?.message?.content || [];
      const textBlocks = content
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c?.text || "")
        .join("");
      const thinkingBlocks = content
        .filter((c: any) => c?.type === "thinking")
        .map((c: any) => c?.thinking || "")
        .filter(Boolean)
        .join("\n\n");
      const toolBlocks = content.filter((c: any) => c?.type === "tool_use");
      if (thinkingBlocks) {
        emit("assistant_thinking", { text: truncate(thinkingBlocks, 4000) });
      }
      if (textBlocks) {
        emit("assistant_text", { text: truncate(textBlocks, 1000) });
      }
      for (const t of toolBlocks) {
        emit("tool_use", { name: t?.name, input_keys: t?.input ? Object.keys(t.input) : [] });
      }
      const u = extractUsage(msg?.message?.usage);
      if (u) emit("usage_updated", { advisory: true }, u);
      return;
    }
    if (type === "user") {
      const content = msg?.message?.content || [];
      const toolResults = content.filter((c: any) => c?.type === "tool_result");
      for (const tr of toolResults) {
        const ok = tr?.is_error !== true;
        emit("tool_result", { ok, content: truncate(stringify(tr?.content), 500) });
      }
      return;
    }
    if (type === "result") {
      resultSubtype = msg?.subtype || "success";
      const u = extractUsage(msg?.usage);
      const cost = typeof msg?.total_cost_usd === "number" ? msg.total_cost_usd : undefined;
      usage = { ...(u || {}), ...(cost != null ? { total_cost_usd: cost } : {}) };
      const isSuccess = resultSubtype === "success";
      emit(isSuccess ? "turn_completed" : "turn_failed", {
        subtype: resultSubtype,
        duration_ms: msg?.duration_ms,
      }, usage);
      return;
    }
    // unknown
    emit("notification", { type, subtype: msg?.subtype });
  }

  const exitResult: TurnResult = await new Promise((resolve) => {
    child.on("error", (e) => {
      cleanup();
      const err = e.message?.includes("ENOENT") ? "claude_not_found" : e.message;
      emit("startup_failed", { reason: err });
      resolve({
        ok: false,
        session_id: sessionId,
        error: err,
        exit_code: null,
        duration_ms: Date.now() - startMs,
      });
    });
    child.on("close", (code) => {
      cleanup();
      const duration_ms = Date.now() - startMs;
      if (cancelled) {
        resolve({
          ok: false,
          session_id: sessionId,
          error: "turn_cancelled",
          exit_code: code,
          duration_ms,
        });
        return;
      }
      if (stalled) {
        resolve({
          ok: false,
          session_id: sessionId,
          error: "stalled",
          exit_code: code,
          duration_ms,
        });
        return;
      }
      if (!firstEventSeen) {
        // No init at all: check for auth hints in stderr
        const stderrLower = stderr.toLowerCase();
        let err = "startup_timeout";
        if (/not found|command not found/.test(stderrLower)) err = "claude_not_found";
        else if (/unauth|api key/.test(stderrLower)) err = "claude_auth_missing";
        emit("startup_failed", { reason: err, stderr: truncate(stderr, 500) });
        resolve({
          ok: false,
          session_id: sessionId,
          error: err,
          exit_code: code,
          duration_ms,
        });
        return;
      }
      if (!resultSubtype) {
        emit("turn_ended_with_error", { reason: "subprocess_exit", code });
        resolve({
          ok: false,
          session_id: sessionId,
          error: "subprocess_exit",
          exit_code: code,
          duration_ms,
        });
        return;
      }
      const ok = resultSubtype === "success";
      resolve({
        ok,
        session_id: sessionId,
        error: ok ? undefined : "turn_failed",
        exit_code: code,
        duration_ms,
        usage,
        result_subtype: resultSubtype,
      });
    });
  });

  return exitResult;
}

function buildArgs(ctx: TurnContext): string[] {
  const args: string[] = ["--output-format", "stream-json", "--verbose", "-p", ctx.prompt];
  const c = ctx.config;
  if (c.model) args.push("--model", c.model);
  if (c.permission_mode) args.push("--permission-mode", c.permission_mode);
  if (c.allowed_tools && c.allowed_tools.length) args.push("--allowedTools", c.allowed_tools.join(","));
  if (c.disallowed_tools && c.disallowed_tools.length)
    args.push("--disallowedTools", c.disallowed_tools.join(","));
  if (c.mcp_config) args.push("--mcp-config", c.mcp_config);
  if (c.add_dir) for (const d of c.add_dir) args.push("--add-dir", d);
  if (ctx.resumeSessionId) args.push("--resume", ctx.resumeSessionId);
  if (c.extra_args) args.push(...c.extra_args);
  return args;
}

function shellQuote(s: string): string {
  // Use single-quote escape: ' -> '\''
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function extractUsage(u: any): TurnResult["usage"] | undefined {
  if (!u || typeof u !== "object") return undefined;
  return {
    input_tokens: numOrZero(u.input_tokens),
    output_tokens: numOrZero(u.output_tokens),
    cache_creation_input_tokens: numOrZero(u.cache_creation_input_tokens),
    cache_read_input_tokens: numOrZero(u.cache_read_input_tokens),
  };
}

function numOrZero(v: any): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function stringify(v: any): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Validate add_dir paths per spec 9.5 invariant 4
export function validateAddDirs(addDir: string[] | undefined, workspaceRoot: string): string[] {
  const errors: string[] = [];
  if (!addDir) return errors;
  const root = path.resolve(workspaceRoot);
  for (const d of addDir) {
    if (!path.isAbsolute(d)) {
      errors.push(`add_dir must be absolute: ${d}`);
      continue;
    }
    const rel = path.relative(root, d);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      errors.push(`add_dir inside workspace.root: ${d}`);
    }
  }
  return errors;
}
