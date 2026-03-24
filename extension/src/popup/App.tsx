import { useState } from "react";
import { searchEmails, EmailResult } from "../api/search";
import ResultCard from "./ResultCard";
import "./App.css";

export default function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EmailResult[]>([]);
  const [gmailAuthEmail, setGmailAuthEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await searchEmails(query);
      setResults(data.results);
      if ("gmailAuthEmail" in data) {
        const g = data.gmailAuthEmail;
        setGmailAuthEmail(
          typeof g === "string" && g.trim() !== "" ? g.trim() : null
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Something went wrong. Is the backend running?";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSearch();
  }

  return (
    <div className="popup-root">
      <div className="noise-bg" aria-hidden="true" />
      <div className="wrap">
        <header className="popup-header">
          <div className="mark">
            <svg
              viewBox="0 0 32 32"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <circle
                cx="14"
                cy="14"
                r="9"
                stroke="#818cf8"
                strokeWidth="1.5"
                opacity="0.9"
              />
              <line
                x1="21"
                y1="21"
                x2="28"
                y2="28"
                stroke="#818cf8"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="14" cy="14" r="3" fill="#6366f1" opacity="0.6" />
            </svg>
            <span>mail-sherlock</span>
          </div>
          <span className="badge">Semantic search</span>
        </header>

        <main>
          <div className="hero">
            <h1 className="hero-title">
              Describe the clue.
              <br />
              <em>Find the message.</em>
            </h1>
            <p className="lead">
              Natural-language search — say what you remember, not the exact
              subject line.
            </p>
          </div>

          <div className="search-row">
            <input
              className="search-input"
              type="text"
              placeholder='e.g. "landlord lease renewal"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSearch}
              disabled={loading}
            >
              {loading ? "…" : "Search"}
            </button>
          </div>

          {error && <p className="error">{error}</p>}

          <div className="results">
            {results.map((email) => (
              <ResultCard
                key={email.id}
                email={email}
                gmailAuthEmail={gmailAuthEmail}
              />
            ))}
            {!loading && results.length === 0 && query && (
              <p className="empty">No results found.</p>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
