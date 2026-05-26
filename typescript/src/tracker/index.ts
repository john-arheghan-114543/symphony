// Tracker interface + factory. Two trackers exist today: GitHub (full
// capability including PR rebase) and Azure DevOps (read-only candidate
// fetching in v1; tag/label writes and PR awareness deferred).

import type {
  Issue,
  RateLimitSnapshot,
  TrackerConfig,
} from "../types.js";
import { GitHubTracker, TrackerError } from "./github.js";
import { AzureDevOpsTracker } from "./ado.js";

export { TrackerError } from "./github.js";

export interface FetchResult {
  issues: Issue[];
  rate: RateLimitSnapshot;
}

/** Capabilities every tracker must provide. */
export interface Tracker {
  readonly kind: "github" | "azuredevops";
  fetchCandidateIssues(): Promise<FetchResult>;
  fetchIssuesByStates(stateNames: string[]): Promise<FetchResult>;
  fetchIssueStatesByIds(ids: string[]): Promise<FetchResult>;
  getRateLimits(): RateLimitSnapshot;
  /**
   * Authenticated clone URL for the issue's repository. May return null
   * when the tracker has no associated git repo (e.g. ADO project without
   * a configured `repository:` key). Populates `SYMPHONY_ISSUE_REPO_URL`
   * in the hook environment.
   */
  cloneUrl(issue: Issue): string | null;
}

/**
 * Narrower interface for trackers that can drive the PR rebase loop.
 * Only GitHub implements this in v1. The orchestrator's `reviewSweep`
 * narrows via `isRebaseCapable(tracker)` before calling these methods.
 */
export interface RebaseCapableTracker extends Tracker {
  readonly kind: "github";
  fetchParkedForReview(label?: string): Promise<FetchResult>;
  swapLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    add: string[],
    remove: string[],
  ): Promise<void>;
}

export function isRebaseCapable(t: Tracker): t is RebaseCapableTracker {
  return t.kind === "github";
}

export function createTracker(cfg: TrackerConfig): Tracker {
  switch (cfg.kind) {
    case "github":
      return new GitHubTracker(cfg);
    case "azuredevops":
      return new AzureDevOpsTracker(cfg);
    default: {
      // Exhaustiveness: if a new kind is added to TrackerConfig the
      // compiler will flag this branch.
      const _exhaustive: never = cfg;
      throw new TrackerError(
        "unsupported_tracker_kind",
        `Unsupported tracker kind: ${(_exhaustive as any)?.kind ?? "unknown"}`,
      );
    }
  }
}
