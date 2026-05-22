// Symphony dashboard — React 18 via ESM CDN, htm for JSX-free templating.
import React, { useEffect, useMemo, useRef, useState } from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";
import htm from "https://esm.sh/htm@3";

const html = htm.bind(React.createElement);

// ---------- small utilities ----------
const fmtNum = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + "k";
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + "M";
};

const fmtCost = (n) => {
  if (n == null) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
};

const fmtDuration = (sec) => {
  if (!Number.isFinite(sec) || sec < 1) return "<1s";
  if (sec < 60) return Math.round(sec) + "s";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const fmtRelative = (iso) => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "now";
  if (ms < 60_000) return Math.floor(ms / 1000) + "s ago";
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + "m ago";
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h ago";
  return Math.floor(ms / 86_400_000) + "d ago";
};

const fmtTime = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const STATE_COLOR = {
  "in progress": "in-progress",
  todo: "",
  default: "",
};

// ---------- subviews ----------
function Brand() {
  return html`
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path
            d="M3 15c2-4 4-4 5 0s4 4 5 0 4-4 5 0 3 1 3 1"
            stroke="white"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <div>
        <div class="brand-name">Extraction</div>
        <div class="brand-tag">Agent orchestrator [Claude · GitHub]</div>
      </div>
    </div>
  `;
}

function StatusPill({ connected, paused }) {
  const cls = !connected ? "disconnected" : paused ? "warn" : "";
  const label = !connected ? "Disconnected" : paused ? "Rate-limited" : "Live";
  return html`
    <div class=${"status-pill " + cls}>
      <span class="status-dot"></span>
      <span>${label}</span>
    </div>
  `;
}

function StatCard({ label, value, gradient, meta }) {
  return html`
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">
        ${gradient ? html`<span class="gradient">${value}</span>` : value}
      </div>
      <div class="stat-meta">${meta || " "}</div>
    </div>
  `;
}

function LabelChips({ labels }) {
  if (!labels || labels.length === 0) return null;
  return html`
    <div class="labels-row">
      ${labels.slice(0, 8).map(
        (l) => html`<span class="label-chip" key=${l}>#${l}</span>`,
      )}
      ${labels.length > 8 ? html`<span class="label-chip">+${labels.length - 8}</span>` : null}
    </div>
  `;
}

function eventCategory(name) {
  if (!name) return "";
  if (/fail|error|cancel|timeout|stall/.test(name)) return "err";
  if (/completed|started|usage|ok|success/.test(name)) return "ok";
  if (/thinking/.test(name)) return "think";
  return "";
}

function RunningCard({ run, expanded, onToggle }) {
  const stateClass = STATE_COLOR[(run.state || "").toLowerCase()] || STATE_COLOR.default;
  const cat = eventCategory(run.last_event);
  const issueUrl = run.url;
  return html`
    <div
      class=${"run-card " + (expanded ? "expanded" : "")}
      onClick=${onToggle}
    >
      <div class="run-head">
        <div style=${{ flex: 1, minWidth: 0 }}>
          <div class="run-id-row">
            <span class="run-ident">${run.issue_identifier}</span>
            <span class=${"run-state-pill " + stateClass}>${run.state}</span>
            ${run.priority != null
              ? html`<span class="run-priority">P${run.priority}</span>`
              : null}
            ${issueUrl
              ? html`<a class="external" href=${issueUrl} target="_blank" rel="noreferrer" onClick=${(e) => e.stopPropagation()}>↗ github</a>`
              : null}
          </div>
          <div class="run-title">${run.title || "(no title)"}</div>
          ${LabelChips({ labels: run.labels })}
        </div>
        <div class="run-tokens">
          <div class="big">${fmtNum(run.tokens?.total_tokens || 0)}${run.tokens?.live ? html`<span class="live-dot" title="streaming"></span>` : null}</div>
          <div class="small">tokens · ${fmtCost(run.cost_usd)}</div>
          <div class="tokens-mini">
            ${fmtNum(run.tokens?.input_tokens || 0)} in · ${fmtNum(run.tokens?.output_tokens || 0)} out · ${fmtNum(run.tokens?.cache_read_input_tokens || 0)} cached
          </div>
        </div>
      </div>

      <div class="run-meta">
        <div class="field">
          <div class="label">Turn</div>
          <div class="value">${run.turn_count || 0}</div>
        </div>
        <div class="field">
          <div class="label">Status</div>
          <div class="value">${run.status}</div>
        </div>
        <div class="field">
          <div class="label">Started</div>
          <div class="value">${fmtRelative(run.started_at)}</div>
        </div>
        <div class="field">
          <div class="label">Session</div>
          <div class="value">${run.session_id ? run.session_id.slice(0, 8) : "—"}</div>
        </div>
        <div class="field">
          <div class="label">PID</div>
          <div class="value">${run.claude_pid || "—"}</div>
        </div>
        <div class="field">
          <div class="label">Cache reads</div>
          <div class="value">${fmtNum(run.tokens?.cache_read_input_tokens || 0)}</div>
        </div>
      </div>

      <div class="run-last">
        <span class=${"event-dot " + cat}></span>
        <span class="event-name">${run.last_event || "waiting"}</span>
        <span class="event-msg">${run.last_message || "(no message yet)"}</span>
      </div>

      ${expanded ? html`
        <div class="run-detail">
          ${run.latest_thinking ? html`
            <div class="thinking-callout">
              <div class="thinking-head">
                <span class="thinking-dot"></span>
                <span class="thinking-label">Thinking</span>
                <span class="thinking-time">${fmtRelative(run.latest_thinking_at)}</span>
              </div>
              <div class="thinking-body">${run.latest_thinking}</div>
            </div>
          ` : null}
          <div class="section-title" style=${{ margin: "0 0 10px" }}>
            Event stream <span class="count">${run.events?.length || 0}</span>
          </div>
          <div class="event-stream">
            ${(run.events || [])
              .slice()
              .reverse()
              .map((ev, idx) => {
                const ec = eventCategory(ev.event);
                const detail = ev.payload
                  ? Object.entries(ev.payload)
                      .filter(([k]) => k !== "stderr")
                      .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`)
                      .join(" ")
                  : "";
                return html`
                  <div class="event-row" key=${idx}>
                    <span class="event-time">${fmtTime(ev.timestamp)}</span>
                    <span class=${"event-tag " + ec}>${ev.event}</span>
                    <span class="event-detail">${detail}</span>
                  </div>
                `;
              })}
            ${(!run.events || run.events.length === 0)
              ? html`<div class="empty">No events yet</div>` : null}
          </div>
          <div style=${{ marginTop: 12, fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--text-3)" }}>
            workspace: ${run.workspace_path || "—"}
          </div>
        </div>
      ` : null}
    </div>
  `;
}

function RetryList({ retrying }) {
  if (!retrying || retrying.length === 0) {
    return html`<div class="empty">Nothing waiting in the retry queue</div>`;
  }
  const now = Date.now();
  return html`
    <div>
      ${retrying.map(
        (r) => html`
          <div class="retry-row" key=${r.issue_id}>
            <div>
              <div class="ident">${r.issue_identifier}</div>
              <div class="meta">attempt #${r.attempt} · ${r.error || "queued"}</div>
            </div>
            <div class="meta">${fmtCountdown(new Date(r.due_at).getTime() - now)}</div>
          </div>
        `,
      )}
    </div>
  `;
}

function fmtCountdown(ms) {
  if (ms <= 0) return "now";
  if (ms < 60_000) return `in ${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`;
  return `in ${Math.round(ms / 3_600_000)}h`;
}

function WorkflowInfo({ wf, totals, rate }) {
  if (!wf) return null;
  return html`
    <div class="workflow-info">
      <div class="row"><span class="k">source</span><span class="v">${wf.source.split("/").slice(-2).join("/")}</span></div>
      <div class="row"><span class="k">tracker</span><span class="v">${wf.tracker_kind}</span></div>
      <div class="row"><span class="k">repository</span><span class="v">${wf.repository || wf.project_id || "—"}</span></div>
      <div class="row"><span class="k">poll</span><span class="v">${(wf.poll_interval_ms / 1000).toFixed(0)}s</span></div>
      <div class="row"><span class="k">max concurrent</span><span class="v">${wf.max_concurrent_agents}</span></div>
      <div class="row"><span class="k">runtime</span><span class="v">${fmtDuration(totals?.seconds_running || 0)}</span></div>
      ${rate ? html`
        <div class="row"><span class="k">graphql left</span><span class="v">${rate.graphql_remaining ?? "—"}</span></div>
      ` : null}
    </div>
  `;
}

function ActivityFeed({ events }) {
  if (!events || events.length === 0) {
    return html`<div class="empty">No recent agent activity</div>`;
  }
  return html`
    <div class="activity">
      ${events
        .slice()
        .reverse()
        .slice(0, 80)
        .map(
          (e, i) => html`
            <div class="activity-line" key=${i}>
              <span class="ts">${fmtTime(e.event.timestamp)}</span>
              <span class="ident">${e.issue_id.slice(0, 6)}</span>
              <span>${e.event.event}${e.event.payload?.name ? ` · ${e.event.payload.name}` : ""}</span>
            </div>
          `,
        )}
    </div>
  `;
}

// ---------- main app ----------
function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [activity, setActivity] = useState([]);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState({});
  const tickRef = useRef(0);
  const [, force] = useState(0);

  // Re-render every second for live "ago" timers
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // SSE connection
  useEffect(() => {
    let es;
    let cancelled = false;
    let retry = 0;
    function connect() {
      es = new EventSource("/api/v1/events");
      es.addEventListener("snapshot", (ev) => {
        try { setSnapshot(JSON.parse(ev.data)); setConnected(true); } catch {}
      });
      es.addEventListener("agent_event", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          setActivity((cur) => {
            const next = [...cur, data];
            if (next.length > 200) next.splice(0, next.length - 200);
            return next;
          });
        } catch {}
      });
      es.addEventListener("error", () => {
        setConnected(false);
        es?.close();
        if (cancelled) return;
        retry = Math.min(retry + 1, 8);
        setTimeout(connect, Math.min(1000 * Math.pow(2, retry), 15000));
      });
    }
    connect();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  const onRefresh = async () => {
    await fetch("/api/v1/refresh", { method: "POST" });
  };

  const running = snapshot?.running || [];
  const retrying = snapshot?.retrying || [];
  const totals = snapshot?.claude_totals;
  const rate = snapshot?.tracker_rate_limits;

  const paused = !!(rate?.retry_after_ms && rate.retry_after_ms > 0);

  return html`
    <div class="app">
      <header class="header">
        ${Brand()}
        <div class="header-right">
          ${StatusPill({ connected, paused })}
          <button class="btn" onClick=${onRefresh} title="Poll now">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
            Poll now
          </button>
        </div>
      </header>

      <main class="main">
        <section class="stats-row">
          ${StatCard({
            label: "Active sessions",
            value: snapshot ? running.length : "—",
            gradient: true,
            meta: snapshot ? `of ${snapshot.workflow.max_concurrent_agents} max` : "",
          })}
          ${StatCard({
            label: "Retry queue",
            value: snapshot ? retrying.length : "—",
            meta: retrying.length > 0 ? `next ${fmtCountdown(new Date(retrying[0].due_at).getTime() - Date.now())}` : "all caught up",
          })}
          ${StatCard({
            label: "Tokens used",
            value: snapshot ? fmtNum(totals?.total_tokens || 0) : "—",
            meta: `${fmtNum(totals?.cache_read_input_tokens || 0)} cache reads`,
          })}
          ${StatCard({
            label: "Cumulative cost",
            value: snapshot ? fmtCost(totals?.total_cost_usd || 0) : "—",
            gradient: true,
            meta: `${fmtDuration(totals?.seconds_running || 0)} compute`,
          })}
        </section>

        <section class="columns">
          <div>
            <div class="section-title">
              <span>Live sessions</span>
              <span class="count">${running.length} running</span>
            </div>
            ${!snapshot
              ? html`<div class="run-grid">${[0, 1].map(i => html`<div class="skeleton" key=${i}></div>`)}</div>`
              : running.length === 0
              ? html`<div class="empty">No active Claude Code sessions. Symphony is polling for eligible issues.</div>`
              : html`
                  <div class="run-grid">
                    ${running.map(
                      (r) => html`
                        <${RunningCard}
                          key=${r.issue_id}
                          run=${r}
                          expanded=${!!expanded[r.issue_id]}
                          onToggle=${() => setExpanded((p) => ({ ...p, [r.issue_id]: !p[r.issue_id] }))}
                        />
                      `,
                    )}
                  </div>
                `}
          </div>

          <aside>
            <div class="side-card">
              <div class="section-title">Retry queue <span class="count">${retrying.length}</span></div>
              ${RetryList({ retrying })}
            </div>
            <div class="side-card">
              <div class="section-title">Workflow</div>
              ${WorkflowInfo({ wf: snapshot?.workflow, totals, rate })}
            </div>
            <div class="side-card">
              <div class="section-title">
                Activity <span class="count">${activity.length}</span>
              </div>
              ${ActivityFeed({ events: activity })}
            </div>
          </aside>
        </section>
      </main>

      <footer class="footer">
        <div>Symphony · TypeScript implementation</div>
        <div>${snapshot ? "last update " + fmtRelative(snapshot.generated_at) : "loading…"}</div>
      </footer>
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
