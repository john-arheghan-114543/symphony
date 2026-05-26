// Pure WIQL string builder for the Azure DevOps tracker. Lives in its own
// module so it can be unit-tested in isolation without HTTP mocking.
//
// WIQL gotchas this module handles:
//  - Single-quote escaping inside string literals (double the quote).
//  - Backslash escaping inside string literals (single backslash in storage
//    becomes \\ in the WIQL source string, then doubled again to survive
//    JSON-encoding by the caller — handled by caller; this module emits
//    only the WIQL form).
//  - `@Me` and `@Today` are macros and must NOT be quoted.
//  - `CONTAINS WORDS` is whole-word (anchored) for tag matching, avoiding
//    "feat" matching "feat-test".

import type { TrackerConfigAdo } from "../types.js";

export interface WiqlOptions {
  /** Limit results to recent changes (mirrors GitHub's 30-day sweep). */
  changedWithinDays?: number;
  /** Resolve `@me` in assignee_filter. ADO has a native WIQL macro. */
  meMacro?: string;
}

/**
 * Build the WIQL query for candidate work items from a TrackerConfigAdo.
 * The query selects only `[System.Id]`; the caller then fetches the rest
 * via `workitemsbatch`.
 */
export function buildCandidateWiql(
  cfg: TrackerConfigAdo,
  opts: WiqlOptions = {},
): string {
  const clauses: string[] = [];

  // Project scope — required for cross-project safety.
  clauses.push(`[System.TeamProject] = ${quote(cfg.project)}`);

  // Active states.
  if (cfg.active_states && cfg.active_states.length > 0) {
    clauses.push(`[System.State] IN (${cfg.active_states.map(quote).join(", ")})`);
  }

  // Work item type filter.
  if (cfg.work_item_types && cfg.work_item_types.length > 0) {
    clauses.push(
      `[System.WorkItemType] IN (${cfg.work_item_types.map(quote).join(", ")})`,
    );
  }

  // Assignee filter. @me passes through as the WIQL @Me macro.
  if (cfg.assignee_filter && cfg.assignee_filter.length > 0) {
    const parts: string[] = [];
    for (const a of cfg.assignee_filter) {
      if (a.toLowerCase() === "@me") {
        parts.push(`[System.AssignedTo] = ${opts.meMacro ?? "@Me"}`);
      } else {
        parts.push(`[System.AssignedTo] = ${quote(a)}`);
      }
    }
    clauses.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
  }

  // AreaPath / IterationPath UNDER filters.
  if (cfg.area_path) {
    clauses.push(`[System.AreaPath] UNDER ${quote(cfg.area_path)}`);
  }
  if (cfg.iteration_path) {
    clauses.push(`[System.IterationPath] UNDER ${quote(cfg.iteration_path)}`);
  }

  // Include tags — each include is its own AND-joined CONTAINS WORDS clause.
  const include = cfg.label_filters?.include ?? [];
  for (const tag of include) {
    clauses.push(`[System.Tags] CONTAINS WORDS ${quote(tag)}`);
  }

  // Exclude tags — NOT CONTAINS WORDS, AND-joined.
  const exclude = cfg.label_filters?.exclude ?? [];
  for (const tag of exclude) {
    clauses.push(`NOT [System.Tags] CONTAINS WORDS ${quote(tag)}`);
  }

  // Bound the result set: WIQL caps at 20k with no pagination, so narrow it.
  if (opts.changedWithinDays && opts.changedWithinDays > 0) {
    clauses.push(`[System.ChangedDate] > @Today - ${opts.changedWithinDays}`);
  }

  const where = clauses.join("\n  AND ");
  return [
    `SELECT [System.Id]`,
    `FROM WorkItems`,
    `WHERE ${where}`,
    `ORDER BY [System.ChangedDate] DESC`,
  ].join("\n");
}

/**
 * Build a WIQL query for a specific list of work-item IDs. Used by
 * `fetchIssueStatesByIds` when the caller already knows the IDs.
 */
export function buildIdsWiql(ids: number[]): string {
  if (ids.length === 0) return `SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 0`;
  return [
    `SELECT [System.Id]`,
    `FROM WorkItems`,
    `WHERE [System.Id] IN (${ids.join(", ")})`,
  ].join("\n");
}

/** Quote a string literal for WIQL: single-quote delimited, embedded quotes doubled. */
export function quote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}
