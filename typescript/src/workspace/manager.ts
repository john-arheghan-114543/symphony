// Workspace manager (Section 9). Per-issue directories, hook lifecycle, safety invariants.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { HooksConfig, Issue, Workspace } from "../types.js";
import { normalizeWorkspacePath, workspaceKey } from "../util/path.js";
import { log } from "../logging/logger.js";
import { treeKill } from "../util/process.js";

export class WorkspaceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export class WorkspaceManager {
  constructor(private root: string) {}

  /**
   * Ensure workspace directory exists for an issue.
   * Sets `created_now` to true only if we created the dir this call.
   */
  async createForIssue(identifier: string): Promise<Workspace> {
    const key = workspaceKey(identifier);
    const wp = normalizeWorkspacePath(this.root, key);

    // Verify parent root exists (create if missing)
    await fs.mkdir(this.root, { recursive: true });

    let created_now = false;
    try {
      await fs.mkdir(wp, { recursive: false });
      created_now = true;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // already there, reuse
        const stat = await fs.stat(wp);
        if (!stat.isDirectory()) {
          throw new WorkspaceError(
            "workspace_not_directory",
            `${wp} exists but is not a directory`,
          );
        }
      } else {
        throw new WorkspaceError("workspace_create_failed", e.message);
      }
    }

    return { path: wp, workspace_key: key, created_now };
  }

  async removeForIssue(identifier: string, hooks: HooksConfig): Promise<void> {
    const key = workspaceKey(identifier);
    const wp = normalizeWorkspacePath(this.root, key);
    let exists = false;
    try {
      const stat = await fs.stat(wp);
      exists = stat.isDirectory();
    } catch {
      return;
    }
    if (!exists) return;
    if (hooks.before_remove) {
      const env = {} as Record<string, string>;
      await runHookBestEffort("before_remove", hooks.before_remove, wp, env, hooks.timeout_ms);
    }
    // Retry with backoff: on Windows, a grandchild process (claude.exe spawned
    // under bash) can briefly keep the directory locked as its CWD after the
    // worker is signalled. Tree-kill should release it, but propagation isn't
    // instant — give it a few tries before giving up.
    const delaysMs = [0, 250, 1000, 3000];
    let lastErr: unknown;
    for (const d of delaysMs) {
      if (d > 0) await new Promise((r) => setTimeout(r, d));
      try {
        await fs.rm(wp, { recursive: true, force: true });
        return;
      } catch (e: any) {
        lastErr = e;
        if (!isRetryableRmError(e)) throw e;
      }
    }
    throw lastErr;
  }
}

export function hookEnv(
  issue: Issue,
  workspacePath: string,
  attempt: number | null,
  /**
   * Authenticated clone URL produced by the tracker. Pass null when the
   * tracker has no associated git repo (e.g. an ADO project without a
   * configured `repository:` key). The URL embeds a secret — never log
   * the full env that contains it.
   */
  repoUrl: string | null = null,
): Record<string, string> {
  return {
    SYMPHONY_ISSUE_ID: issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    SYMPHONY_ISSUE_NUMBER: String(issue.number),
    SYMPHONY_ISSUE_REPOSITORY: issue.repository,
    SYMPHONY_ISSUE_REPO_URL: repoUrl ?? "",
    SYMPHONY_ISSUE_TITLE: issue.title ?? "",
    SYMPHONY_ISSUE_BRANCH_NAME: issue.branch_name ?? "",
    SYMPHONY_ISSUE_STATE: issue.state,
    SYMPHONY_ATTEMPT: attempt == null ? "" : String(attempt),
    SYMPHONY_WORKSPACE_PATH: workspacePath,
  };
}

let resolvedBashPath: string | undefined;

// Pick a bash binary that won't dispatch into WSL. On Windows, the unqualified
// "bash" on PATH is typically C:\Windows\System32\bash.exe — the WSL launcher,
// which fails with `execvpe(/bin/bash) failed` when no WSL distro is registered.
// Prefer SYMPHONY_BASH, then Git Bash, then plain "bash" (correct on Linux/macOS).
export function resolveBashPath(): string {
  if (resolvedBashPath !== undefined) return resolvedBashPath;
  const override = process.env.SYMPHONY_BASH;
  if (override && override.length > 0) {
    resolvedBashPath = override;
    return resolvedBashPath;
  }
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        resolvedBashPath = c;
        return resolvedBashPath;
      }
    }
  }
  resolvedBashPath = "bash";
  return resolvedBashPath;
}

export async function runHook(
  name: string,
  script: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(resolveBashPath(), ["-lc", script], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        treeKill(child.pid, "SIGTERM");
        setTimeout(() => {
          if (child.pid && !child.killed) treeKill(child.pid, "SIGKILL");
        }, 2000);
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 64_000) stdout = stdout.slice(-64_000);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      log[ok ? "debug" : "warn"](`hook=${name} ${ok ? "ok" : "failed"}`, {
        cwd,
        code,
        timed_out: timedOut,
        stderr: ok ? undefined : truncate(stderr, 600).replace(/\s+/g, " ").trim(),
        stdout_tail: ok ? undefined : truncate(stdout, 200).replace(/\s+/g, " ").trim(),
      });
      resolve({
        ok,
        code,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        error: timedOut ? "hook_timeout" : ok ? undefined : "hook_failed",
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: e.message });
    });
  });
}

export async function runHookBestEffort(
  name: string,
  script: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  try {
    await runHook(name, script, cwd, env, timeoutMs);
  } catch (e: any) {
    log.warn(`hook=${name} threw, ignored`, { error: e?.message });
  }
}

function truncate(s: string, n = 4096): string {
  return s.length > n ? s.slice(0, n) + `...<${s.length - n} more bytes>` : s;
}

function isRetryableRmError(e: any): boolean {
  const code = e?.code;
  return (
    code === "EBUSY" ||
    code === "EPERM" ||
    code === "EACCES" ||
    code === "ENOTEMPTY"
  );
}
