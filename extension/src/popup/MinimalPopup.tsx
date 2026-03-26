import { useEffect, useRef, useState } from "react";
import {
  searchEmails,
  gmailWebUrlForThread,
  type EmailResult,
} from "../api/search";
import "./minimal-popup.css";

const WEB_APP = "http://127.0.0.1:8000";

export default function MinimalPopup() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EmailResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [gmailEmail, setGmailEmail] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Check backend health + autofocus */
  useEffect(() => {
    inputRef.current?.focus();
    fetch(`${WEB_APP}/health`)
      .then((r) => setConnected(r.ok))
      .catch(() => setConnected(false));
  }, []);

  async function handleSearch() {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await searchEmails(q, 7);
      setResults(data.results);
      setGmailEmail(
        typeof data.gmailAuthEmail === "string" && data.gmailAuthEmail.trim()
          ? data.gmailAuthEmail.trim()
          : null,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") void handleSearch();
  }

  const connDot =
    connected === null ? "dot--idle" : connected ? "dot--on" : "dot--off";
  const connLabel =
    connected === null ? "Connecting…" : connected ? "Connected" : "Offline";

  return (
    <div className="pp">
      {/* ── Header ──────────────────────────────────── */}
      <div className="pp-header">
        <div className="pp-brand">
          <svg
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <circle cx="14" cy="14" r="9" stroke="#5B8DEF" strokeWidth="1.5" />
            <line
              x1="21" y1="21" x2="28" y2="28"
              stroke="#5B8DEF"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <circle cx="14" cy="14" r="3.5" fill="#5B8DEF" opacity="0.45" />
          </svg>
          <span>mail-sherlock</span>
        </div>
        <div className="pp-status">
          <span className={`pp-dot ${connDot}`} />
          <span className="pp-status-label">{connLabel}</span>
        </div>
      </div>

      {/* ── Search input ────────────────────────────── */}
      <div className="pp-search-wrap">
        <input
          ref={inputRef}
          className="pp-input"
          type="text"
          placeholder="onboarding directions from project lead…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          aria-label="Search your emails"
        />
      </div>

      {/* ── Filter + search button row ───────────────── */}
      <div className="pp-filter-row">
        <div className="pp-chips">
          <span className="pp-chip pp-chip--static" title="Time filter: week">W</span>
          <span className="pp-chip pp-chip--static" title="Time filter: month">M</span>
          <span className="pp-chip pp-chip--static pp-chip--icon" title="Has attachment" aria-label="Attachment filter">
            📎
          </span>
          <span className="pp-chip pp-chip--static pp-chip--icon" title="Filter by sender" aria-label="From filter">
            @
          </span>
        </div>
        <button
          className="pp-search-btn"
          onClick={() => void handleSearch()}
          disabled={loading || !query.trim()}
        >
          {loading ? <span className="pp-spinner" aria-hidden="true" /> : "Search"}
        </button>
      </div>

      {/* ── Results ─────────────────────────────────── */}
      <div className="pp-body">
        {error && <div className="pp-error">{error}</div>}

        {results !== null && results.length === 0 && !error && (
          <div className="pp-empty">
            <p>No results found.</p>
            <p className="pp-empty-hint">Try broadening your description.</p>
          </div>
        )}

        {results !== null && results.length > 0 && (
          <ul className="pp-results" role="list">
            {results.map((r) => {
              const threadId = r.threadId?.trim();
              const url =
                threadId && gmailEmail
                  ? gmailWebUrlForThread(threadId, gmailEmail)
                  : threadId
                    ? `https://mail.google.com/mail/#all/${threadId}`
                    : null;
              return (
                <li key={r.id}>
                  <a
                    className="pp-result"
                    href={url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={url ? `Open in Gmail` : "Sync emails to enable Gmail links"}
                  >
                    <div className="pp-result__subject">{r.subject}</div>
                    <div className="pp-result__meta">
                      <span className="pp-result__sender">{r.sender}</span>
                      {r.sender && r.date && <span aria-hidden="true">·</span>}
                      <span className="pp-result__date">{r.date}</span>
                      <span className="pp-result__score">
                        {Math.round(r.score * 100)}%
                      </span>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}

        {results === null && !loading && (
          <div className="pp-empty">
            {connected === false ? (
              <>
                <p>Backend not reachable.</p>
                <p className="pp-empty-hint">
                  Start the API, then{" "}
                  <a href={`${WEB_APP}/auth/login`} target="_blank" rel="noopener">
                    authorize Gmail
                  </a>{" "}
                  in the web app.
                </p>
              </>
            ) : (
              <p>Type above and press Enter to search.</p>
            )}
          </div>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────── */}
      <div className="pp-footer">
        <a
          className="pp-footer-link"
          href={WEB_APP}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Web App
        </a>
        <span className="pp-footer-dot" aria-hidden="true" />
        <a
          className="pp-footer-link"
          href={`${WEB_APP}/emails/sync`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Sync
        </a>
      </div>
    </div>
  );
}
