import { useState } from "react";
import "./Dashboard.css";
import type { Page } from "../App";
import iconUrl from "../assets/icon.png";
import type { EmailResult, SearchResponse } from "../types";

interface Props {
  navigate: (to: Page) => void;
}

function initials(from: string): string {
  const name = from.split("@")[0].replace(/[._-]/g, " ");
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function scoreBarColor(score: number): string {
  if (score >= 90) return "#9B72CF";
  if (score >= 75) return "#CFA0C0";
  return "#E2D4F0";
}

const MOCK: EmailResult[] = [
  { id: "m1", from: "landlord@property.com", subject: "Lease extension confirmation — June 2025", snippet: "Hi, we can extend the lease until June 2025. Monthly rent stays at $1,200. Please sign the attached document...", date: "Sep 1, 2024", account: "work@gmail.com", initials: "JL", avatarBg: "#F0C4DC", avatarColor: "#72243E", tags: [{ label: "housing", bg: "#FBEAF0", color: "#72243E" }, { label: "finance", bg: "#E6F1FB", color: "#0C447C" }], score: 98 },
  { id: "m2", from: "prof.miller@university.edu", subject: "Midterm deadline extended to March 18th", snippet: "Due to the lab outage last week, the midterm submission deadline has been moved to March 18th at 11:59 PM...", date: "Mar 10, 2025", account: "school@gmail.com", initials: "PM", avatarBg: "#E6F1FB", avatarColor: "#0C447C", tags: [{ label: "school", bg: "#FAEEDA", color: "#633806" }, { label: "deadline", bg: "#E1F5EE", color: "#085041" }], score: 91 },
  { id: "m3", from: "client@business.com", subject: "Project rate confirmation — $85/hr", snippet: "We confirm the hourly rate of $85 for your consulting work on the redesign project starting November 1st...", date: "Oct 10, 2024", account: "work@gmail.com", initials: "CB", avatarBg: "#FBEAF0", avatarColor: "#72243E", tags: [{ label: "finance", bg: "#E6F1FB", color: "#0C447C" }, { label: "work", bg: "#E1F5EE", color: "#085041" }], score: 87 },
  { id: "m4", from: "noreply@chase.com", subject: "Your February statement is ready", snippet: "Your Chase Sapphire statement for February 2025 is now available. Total balance: $342.18. Due March 2nd.", date: "Feb 3, 2025", account: "personal@gmail.com", initials: "BK", avatarBg: "#E1F5EE", avatarColor: "#085041", tags: [{ label: "finance", bg: "#E6F1FB", color: "#0C447C" }], score: 74 },
];

const ACCOUNTS = [
  { email: "work@gmail.com", dot: "#34A853", count: 482 },
  { email: "personal@gmail.com", dot: "#4285F4", count: 391 },
  { email: "school@gmail.com", dot: "#9B72CF", count: 367 },
];

const FILTERS = ["All accounts", "work@gmail.com", "personal@gmail.com", "Has attachment", "Unread only", "Last 30 days"];

const LABELS = [
  { name: "Housing", dot: "#F0C4DC" },
  { name: "Finance", dot: "#B5D4F4" },
  { name: "Work", dot: "#9FE1CB" },
  { name: "School", dot: "#FAC775" },
];

export default function Dashboard({ navigate }: Props) {
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("All accounts");
  const [results, setResults] = useState<EmailResult[]>(MOCK);
  const [isMock, setIsMock] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gmailEmail, setGmailEmail] = useState<string | null>(null);

  async function handleSearch(e?: React.FormEvent) {
    e?.preventDefault();
    const text = query.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data: SearchResponse = await res.json();
      if (data.gmailAuthEmail) setGmailEmail(data.gmailAuthEmail);
      const mapped: EmailResult[] = (data.results ?? []).map((r) => ({
        ...r,
        initials: initials(r.from ?? ""),
        avatarBg: "#F0C4DC",
        avatarColor: "#72243E",
      }));
      setResults(mapped);
      setIsMock(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="db">
      {/* ── Nav ── */}
      <nav className="db-nav">
        <div className="db-nav-left">
          <div className="db-logo">
            <img src={iconUrl} alt="" width={55} height={55} style={{ objectFit: "contain" }} />
            Mail Sherlock
          </div>
          <div className="db-nav-links">
            <span className="db-nav-link active">Dashboard</span>
            <span className="db-nav-link">Accounts</span>
            <span className="db-nav-link">Insights</span>
            <span className="db-nav-link">Settings</span>
          </div>
        </div>
        <div className="db-nav-right">
          <a href="/auth/login" className="db-btn-connect">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <line x1="6" y1="1" x2="6" y2="11" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
              <line x1="1" y1="6" x2="11" y2="6" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Connect account
          </a>
          <button className="db-avatar" onClick={() => navigate("landing")}>LN</button>
        </div>
      </nav>

      <div className="db-layout">
        {/* ── Sidebar ── */}
        <aside className="db-sidebar">
          <div className="db-sidebar-section">
            <div className="db-sidebar-label">Search</div>
            {[
              { label: "All emails", active: true, icon: <svg viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4"/><line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg> },
              { label: "Unread", active: false, icon: <svg viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.3"/><path d="M5 7h6M5 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg> },
              { label: "Attachments", active: false, icon: <svg viewBox="0 0 16 16" fill="none"><path d="M4 4h8M4 8h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3"/></svg> },
            ].map((item) => (
              <div key={item.label} className={`db-sidebar-item${item.active ? " active" : ""}`}>
                <svg width="16" height="16">{item.icon}</svg>
                {item.label}
              </div>
            ))}
          </div>

          <div className="db-sidebar-section">
            <div className="db-sidebar-label">Labels</div>
            {LABELS.map((l) => (
              <div key={l.name} className="db-sidebar-item">
                <span className="db-label-dot" style={{ background: l.dot }} />
                {l.name}
              </div>
            ))}
          </div>

          <div className="db-sidebar-section">
            <div className="db-sidebar-label">Accounts</div>
            {[...ACCOUNTS, ...(gmailEmail && !ACCOUNTS.find(a => a.email === gmailEmail) ? [{ email: gmailEmail, dot: "#34A853", count: 0 }] : [])].map((acc) => (
              <div key={acc.email} className="db-acc-item">
                <div className="db-acc-dot" style={{ background: acc.dot }} />
                <div className="db-acc-name">{acc.email}</div>
                {acc.count > 0 && <div className="db-acc-count">{acc.count}</div>}
              </div>
            ))}
            <a href="/auth/login" className="db-add-acc">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <line x1="6" y1="1" x2="6" y2="11" stroke="#9B72CF" strokeWidth="1.6" strokeLinecap="round" />
                <line x1="1" y1="6" x2="11" y2="6" stroke="#9B72CF" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Add account
            </a>
          </div>
        </aside>

        {/* ── Main ── */}
        <main className="db-main">
          <div className="db-page-header">
            <h1>Good morning, Lin</h1>
            <p>1,240 emails indexed across {ACCOUNTS.length} accounts · Last synced 2 min ago</p>
          </div>

          <form onSubmit={handleSearch}>
            <div className="db-search-wrap">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="6.5" cy="6.5" r="4.5" stroke="#9B72CF" strokeWidth="1.5" />
                <line x1="10" y1="10" x2="14" y2="14" stroke="#9B72CF" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                placeholder="Describe the email you're looking for..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="db-search-btn" type="submit" disabled={loading || !query.trim()}>
                {loading ? "Searching…" : "Search"}
              </button>
            </div>
          </form>

          <div className="db-chips">
            {FILTERS.map((f) => (
              <span
                key={f}
                className={`db-chip${activeFilter === f ? " active" : ""}`}
                onClick={() => setActiveFilter(f)}
              >
                {f}
              </span>
            ))}
          </div>

          {/* Stats */}
          <div className="db-stats">
            {[
              { num: "1,240", label: "Emails indexed" },
              { num: "3", label: "Accounts connected" },
              { num: "47", label: "Unread emails" },
              { num: "12", label: "With attachments" },
            ].map((s) => (
              <div key={s.label} className="db-stat">
                <div className="db-stat-num">{s.num}</div>
                <div className="db-stat-label">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Results */}
          <div className="db-results-header">
            <div className="db-results-title">
              {isMock ? "Recent / top results" : `Top results — ${results.length} found`}
            </div>
            <div className="db-results-sort">
              Sort by relevance
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 5l3 3 3-3" stroke="#bbb" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>

          {error && <div className="db-error">{error}</div>}

          <div className="db-results-list">
            {results.length > 0 ? results.map((r) => {
              const score = r.score ?? 0;
              const barColor = scoreBarColor(score);
              const ini = r.initials ?? initials(r.from ?? "");
              const tags = r.tags ?? [];
              const gmailLink = r.id && (gmailEmail || r.account)
                ? `https://mail.google.com/mail/u/0/#inbox/${r.id}`
                : null;
              return (
                <a
                  key={r.id}
                  className="db-result-card"
                  href={gmailLink ?? "#"}
                  target={gmailLink ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  onClick={gmailLink ? undefined : (e) => e.preventDefault()}
                >
                  <div className="db-bar" style={{ background: barColor }} />
                  <div className="db-av" style={{ background: r.avatarBg ?? "#F0C4DC", color: r.avatarColor ?? "#72243E" }}>
                    {ini}
                  </div>
                  <div className="db-rbody">
                    <div className="db-rtop">
                      <span className="db-rfrom">{r.from}</span>
                      <span className="db-rmeta">
                        {r.account && (
                          <span className="db-racc">
                            <span className="db-racc-dot" style={{ background: ACCOUNTS.find(a => a.email === r.account)?.dot ?? "#9B72CF" }} />
                            {r.account}
                          </span>
                        )}
                        {r.account && r.date && " · "}
                        {r.date}
                      </span>
                    </div>
                    <div className="db-rsubj">{r.subject}</div>
                    <div className="db-rsnip">{r.snippet}</div>
                    <div className="db-rtags">
                      {tags.map((t, i) => (
                        <span key={i} className="db-rtag" style={{ background: t.bg, color: t.color }}>
                          {t.label}
                        </span>
                      ))}
                      {score > 0 && <span className="db-rscore">{score}% match</span>}
                    </div>
                  </div>
                </a>
              );
            }) : !loading && (
              <div className="db-empty">
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                  <circle cx="17" cy="17" r="12" stroke="#ddd" strokeWidth="2"/>
                  <line x1="26" y1="26" x2="36" y2="36" stroke="#ddd" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                <p>No messages matched your query.</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
