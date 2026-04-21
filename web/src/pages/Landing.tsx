import "./Landing.css";
import iconUrl from "../assets/icon.png";
import { authLoginUrl } from "../api/http";

function GoogleIcon() {
  return (
    <svg className="ls-google-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

export default function Landing() {
  return (
    <div className="ls-login-root">
      <div className="ls-orb ls-orb-1" />
      <div className="ls-orb ls-orb-2" />
      <div className="ls-orb ls-orb-3" />

      <section className="ls-left">
        <div className="ls-logo-row">
          <img src={iconUrl} alt="Mail Sherlock logo" className="ls-logo-icon-img" />
          <span className="ls-logo-text">Mail Sherlock</span>
        </div>

        <h1 className="ls-headline">
          Your inbox,<br />
          <em>finally</em>
          <br />
          understood.
        </h1>
        <p className="ls-sub">
          Ask anything about your email in plain language. Mail Sherlock finds it,
          reads it, and tells you exactly what you need.
        </p>

        <div className="ls-features">
          <div className="ls-feature"><span className="ls-dot" />Semantic search by meaning, not keywords</div>
          <div className="ls-feature"><span className="ls-dot" />Multi-account Gmail support</div>
          <div className="ls-feature"><span className="ls-dot" />Local-first index for better privacy</div>
          <div className="ls-feature"><span className="ls-dot" />Auto-extracted events and reminders</div>
        </div>
      </section>

      <section className="ls-right">
        <div className="ls-card">
          <p className="ls-card-eyebrow">Sign in</p>
          <p className="ls-card-title">Welcome back</p>
          <p className="ls-card-sub">
            Connect your Gmail account to start searching your inbox.
          </p>

          <button
            className="ls-google-btn"
            onClick={() => (window.location.href = authLoginUrl())}
            type="button"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <p className="ls-gmail-note">
            A Gmail account is required. Mail Sherlock only supports Google accounts at this time.
          </p>

          <div className="ls-privacy-row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <p className="ls-privacy">
              Your emails are indexed <strong>locally on your machine</strong>. We never send your inbox content to third-party servers.
            </p>
          </div>
        </div>
        <p className="ls-footer">CS4800 class project · Mail Sherlock</p>
      </section>
    </div>
  );
}
