import { useState } from "react";
import { searchEmails, EmailResult } from "../api/search";
import ResultCard from "./ResultCard";
import "./App.css";

export default function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EmailResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await searchEmails(query);
      setResults(data.results);
    } catch {
      setError("Could not reach the backend. Make sure the server is running.");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSearch();
  }

  return (
    <div className="container">
      <h1 className="title">mail-sherlock</h1>
      <p className="subtitle">Describe the email you're looking for</p>

      <div className="search-row">
        <input
          className="search-input"
          type="text"
          placeholder='e.g. "email about my lease renewal"'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <button className="search-btn" onClick={handleSearch} disabled={loading}>
          {loading ? "..." : "Search"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="results">
        {results.map((email) => (
          <ResultCard key={email.id} email={email} />
        ))}
        {!loading && results.length === 0 && query && (
          <p className="empty">No results found.</p>
        )}
      </div>
    </div>
  );
}
