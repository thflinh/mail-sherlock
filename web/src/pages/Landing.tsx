import "./Landing.css";
import type { Page } from "../App";
import iconUrl from "../assets/icon.png";

interface Props {
  navigate: (to: Page) => void;
}

function CheckIcon({ yes }: { yes: boolean }) {
  return (
    <div className={`check-icon ${yes ? "check-yes" : "check-no"}`}>
      {yes ? (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 5l2 2 4-4" stroke="#72243E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M3 3l4 4M7 3l-4 4" stroke="#bbb" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

export default function Landing({ navigate }: Props) {
  return (
    <div className="lp">
      {/* ── Nav ── */}
      <nav className="lp-nav">
        <div className="lp-logo">
          <img src={iconUrl} alt="" className="lp-logo-img" />
          Mail Sherlock
        </div>
        <div className="lp-nav-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#compare">Compare</a>
        </div>
        <div className="lp-nav-cta">
          <button className="btn-ghost" onClick={() => navigate("dashboard")}>
            Sign in
          </button>
          <button className="btn-fill" onClick={() => navigate("dashboard")}>
            Get started free
          </button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="lp-hero">
        <div className="lp-badge">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1l1.2 2.6L10 4.5l-2 1.9.5 2.6L6 7.7l-2.5 1.3.5-2.6-2-1.9 2.8-.9z" fill="#993556" />
          </svg>
          Free · Private · Local
        </div>
        <h1 className="lp-h1">
          Find any email by just{" "}
          <span className="lp-h1-accent">describing it</span>
        </h1>
        <p className="lp-sub">
          Stop hunting for keywords. Type what you remember and Mail Sherlock
          finds it — across all your Gmail accounts at once.
        </p>
        <div className="lp-hero-btns">
          <button className="btn-hero-fill" onClick={() => navigate("dashboard")}>
            Get started free
          </button>
          <a href="#how" className="btn-hero-ghost">
            See how it works
          </a>
        </div>

        {/* Demo card */}
        <div className="lp-demo">
          <div className="lp-demo-label">Try an example search</div>
          <div className="lp-demo-search">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="5.5" cy="5.5" r="4" stroke="#9B72CF" strokeWidth="1.4" />
              <line x1="9" y1="9" x2="13" y2="13" stroke="#9B72CF" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>"email where my landlord confirmed the rent price"</span>
            <div className="lp-demo-search-btn">Search</div>
          </div>
          {[
            { ini: "JL", bg: "#F0C4DC", clr: "#72243E", from: "landlord@property.com", acct: "work@gmail.com", subj: "Lease extension confirmation — June 2025", snip: "Hi, we can extend the lease until June 2025. Monthly rent stays at $1,200...", score: "98%" },
            { ini: "PM", bg: "#EEF4FF", clr: "#0C447C", from: "property.mgmt@homes.com", acct: "personal@gmail.com", subj: "Renewal offer — unit 4B", snip: "Please review the attached renewal terms. Rent will increase by 3%...", score: "84%" },
          ].map((r) => (
            <div key={r.ini} className="lp-demo-result">
              <div className="lp-demo-av" style={{ background: r.bg, color: r.clr }}>{r.ini}</div>
              <div className="lp-demo-body">
                <div className="lp-demo-from">
                  {r.from} <span className="lp-demo-acct">· {r.acct}</span>
                </div>
                <div className="lp-demo-subj">{r.subj}</div>
                <div className="lp-demo-snip">{r.snip}</div>
              </div>
              <div className="lp-demo-score">{r.score}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="lp-section" id="how">
        <div className="lp-section-tag">How it works</div>
        <h2 className="lp-section-h2">Three steps to find any email</h2>
        <p className="lp-section-sub">
          No setup beyond connecting your accounts. No keywords, no folders, no filters.
        </p>
        <div className="lp-steps">
          {[
            { n: "1", title: "Connect your accounts", desc: "Sign in with Google once per account. Mail Sherlock reads your emails securely via the Gmail API." },
            { n: "2", title: "We index your inbox", desc: "Your emails are converted to AI embeddings locally on your machine. Nothing is sent to a server." },
            { n: "3", title: "Just describe it", desc: "Type what you remember in plain English. The model finds the closest matches by meaning, not words." },
          ].map((s) => (
            <div key={s.n} className="lp-step">
              <div className="lp-step-num">{s.n}</div>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section className="lp-features-section" id="features">
        <div className="lp-features-inner">
          <div className="lp-section-tag">Features</div>
          <h2 className="lp-section-h2">Everything your inbox was missing</h2>
          <p className="lp-section-sub">Built for people with busy, multi-account inboxes who need results fast.</p>
          <div className="lp-features-grid">
            {[
              { bg: "#FBEAF0", stroke: "#993556", title: "Multi-account search", desc: "Search Gmail, personal, and school accounts simultaneously with one query.", icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#993556" strokeWidth="1.5"/><path d="M7 10l2 2 4-4" stroke="#993556" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg> },
              { bg: "#F5F0FF", stroke: "#534AB7", title: "Semantic search", desc: "Finds emails by meaning, not exact words. Works even when you misremember the phrasing.", icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="3" y="4" width="14" height="12" rx="2" stroke="#534AB7" strokeWidth="1.5"/><path d="M7 9h6M7 12h4" stroke="#534AB7" strokeWidth="1.3" strokeLinecap="round"/></svg> },
              { bg: "#E1F5EE", stroke: "#0F6E56", title: "100% private", desc: "Embeddings are built and stored locally. Your emails never leave your device.", icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 3v5l3 2" stroke="#0F6E56" strokeWidth="1.5" strokeLinecap="round"/><circle cx="10" cy="10" r="7.5" stroke="#0F6E56" strokeWidth="1.5"/></svg> },
              { bg: "#FBEAF0", stroke: "#993556", title: "Smart auto-tags", desc: "Emails are automatically labeled — finance, work, housing, travel — for faster filtering.", icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 6h12M4 10h8M4 14h10" stroke="#993556" strokeWidth="1.5" strokeLinecap="round"/></svg> },
              { bg: "#F5F0FF", stroke: "#534AB7", title: "Chrome extension", desc: "Works directly in your browser as a popup or sidebar. No separate app needed.", icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="6" height="6" rx="1.5" stroke="#534AB7" strokeWidth="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5" stroke="#534AB7" strokeWidth="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5" stroke="#534AB7" strokeWidth="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5" stroke="#534AB7" strokeWidth="1.5"/></svg> },
              { bg: "#E1F5EE", stroke: "#0F6E56", title: "Relevance scoring", desc: "Every result shows a match percentage so you always know why it was surfaced.", icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4v3M10 13v3M4 10H7M13 10h3" stroke="#0F6E56" strokeWidth="1.5" strokeLinecap="round"/><circle cx="10" cy="10" r="7" stroke="#0F6E56" strokeWidth="1.3"/></svg> },
            ].map((f) => (
              <div key={f.title} className="lp-feat">
                <div className="lp-feat-icon" style={{ background: f.bg }}>{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Compare ── */}
      <section className="lp-section" id="compare">
        <div className="lp-section-tag">Comparison</div>
        <h2 className="lp-section-h2">Why not just use Gmail Gemini?</h2>
        <p className="lp-section-sub">
          Gemini and Copilot are great — but they're paid, siloed, and send your data to the cloud.
        </p>
        <div className="lp-compare-grid">
          {[
            { name: "Gmail Gemini", sub: "Google AI Pro/Ultra", ours: false, rows: [true, false, false, false] },
            { name: "Mail Sherlock", sub: "Free forever", ours: true, rows: [true, true, true, true] },
            { name: "Outlook Copilot", sub: "Microsoft 365 paid add-on", ours: false, rows: [true, false, false, false] },
          ].map((col) => (
            <div key={col.name} className={`lp-compare-card${col.ours ? " lp-compare-ours" : ""}`}>
              {col.ours && <div className="lp-best-badge">Best pick</div>}
              <div className="lp-compare-name">{col.name}</div>
              <div className="lp-compare-sub">{col.sub}</div>
              {["Natural language search", "Multi-account search", "Runs locally / private", "Free to use"].map((row, i) => (
                <div key={row} className="lp-compare-row">
                  <CheckIcon yes={col.rows[i]} />
                  <span style={{ color: col.rows[i] ? "var(--text2)" : "var(--muted2)" }}>{row}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA band ── */}
      <div className="lp-cta-band">
        <h2>Start finding emails in seconds</h2>
        <p>Free to install. No credit card. Your emails stay on your machine.</p>
        <button className="lp-cta-btn" onClick={() => navigate("dashboard")}>
          Get started free →
        </button>
      </div>

      {/* ── Footer ── */}
      <footer className="lp-footer">
        <div className="lp-footer-logo">
          <img src={iconUrl} alt="" width={28} height={28} style={{ objectFit: "contain" }} />
          Mail Sherlock
        </div>
        <div className="lp-footer-links">
          <a href="#">Privacy</a>
          <a href="#">GitHub</a>
          <a href="#">Contact</a>
        </div>
        <div className="lp-footer-note">CS4800 project · 2025</div>
      </footer>
    </div>
  );
}
