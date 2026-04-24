import "./Landing.css";
import iconUrl from "../assets/icon.png";

export default function Privacy() {
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
          Privacy
          <br />
          <em>Policy</em>
        </h1>
        <p className="ls-sub">
          This policy explains how Mail Sherlock Team uses and protects information when you connect your
          Google account to Mail Sherlock.
        </p>
      </section>

      <section className="ls-right">
        <div className="ls-card ls-doc-card">
          <p className="ls-card-eyebrow">Legal</p>
          <p className="ls-card-title">Privacy Policy</p>
          <p className="ls-card-sub">Effective date: April 24, 2026</p>

          <div className="ls-doc-content">
            <h3>1. Who we are</h3>
            <p>
              Mail Sherlock is operated by Mail Sherlock Team. If you have questions about this policy or
              want to request data deletion, contact us at <a href="mailto:ptlinhuni@gmail.com">ptlinhuni@gmail.com</a>.
            </p>

            <h3>2. Google data we access</h3>
            <p>
              Mail Sherlock requests Google scope <code>https://www.googleapis.com/auth/gmail.readonly</code>.
              This allows read-only access to your Gmail messages and metadata so the app can provide inbox
              search, summarization, and extraction features.
            </p>

            <h3>3. How data is used</h3>
            <p>
              We use Gmail-derived data only to provide user-requested product features and operate the
              service. Mail Sherlock does not send, delete, or modify your Gmail messages.
            </p>

            <h3>4. Sharing and advertising</h3>
            <p>
              We do not sell Google user data and we do not use Google user data for advertising. We only
              share data with service providers that help operate the app under confidentiality obligations,
              or when required by law.
            </p>

            <h3>5. Retention and deletion</h3>
            <p>
              We retain data only as long as needed to provide the service, maintain security, and comply
              with legal obligations. You may revoke Google access at any time from your Google account
              permissions and request deletion by emailing <a href="mailto:ptlinhuni@gmail.com">ptlinhuni@gmail.com</a>.
            </p>

            <h3>6. Security</h3>
            <p>
              We apply reasonable safeguards including access controls, encrypted transport, and restricted
              internal access on a need-to-know basis.
            </p>
          </div>

          <div className="ls-doc-actions">
            <a href="#/" className="ls-doc-link">Back to Home</a>
            <a href="#/terms" className="ls-doc-link">View Terms</a>
          </div>
        </div>
      </section>
    </div>
  );
}
