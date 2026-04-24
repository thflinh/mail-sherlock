import "./Landing.css";
import iconUrl from "../assets/icon.png";

export default function Terms() {
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
          Terms of
          <br />
          <em>Service</em>
        </h1>
        <p className="ls-sub">
          These terms explain the rules for using Mail Sherlock and connecting your Google account for
          Gmail-powered features.
        </p>
      </section>

      <section className="ls-right">
        <div className="ls-card ls-doc-card">
          <p className="ls-card-eyebrow">Legal</p>
          <p className="ls-card-title">Terms of Service</p>
          <p className="ls-card-sub">Effective date: April 24, 2026</p>

          <div className="ls-doc-content">
            <h3>1. Acceptance of terms</h3>
            <p>
              By using Mail Sherlock, you agree to these Terms of Service. If you do not agree, do not use
              the service.
            </p>

            <h3>2. Gmail connection</h3>
            <p>
              To enable Gmail-based features, you may connect a Google account and authorize read-only Gmail
              access using scope <code>https://www.googleapis.com/auth/gmail.readonly</code>.
            </p>

            <h3>3. Read-only behavior</h3>
            <p>
              Mail Sherlock is designed for read-only inbox intelligence. The app does not request permissions
              to send, delete, or modify Gmail messages.
            </p>

            <h3>4. User responsibilities</h3>
            <p>
              You are responsible for maintaining account security, ensuring you are authorized to use the
              connected account, and using the service lawfully.
            </p>

            <h3>5. Service changes and termination</h3>
            <p>
              Mail Sherlock Team may update, suspend, or terminate service access for security, abuse, legal
              compliance, or operational reasons. You can revoke Google access at any time from your Google
              account permissions.
            </p>

            <h3>6. Contact</h3>
            <p>
              For legal or service questions, contact <a href="mailto:ptlinhuni@gmail.com">ptlinhuni@gmail.com</a>.
            </p>
          </div>

          <div className="ls-doc-actions">
            <a href="#/" className="ls-doc-link">Back to Home</a>
            <a href="#/privacy" className="ls-doc-link">View Privacy Policy</a>
          </div>
        </div>
      </section>
    </div>
  );
}
