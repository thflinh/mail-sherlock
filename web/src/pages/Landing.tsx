import { useState } from "react";
import "./Landing.css";
import type { Page } from "../App";
import iconUrl from "../assets/icon.png";
import { loginEmail, signupEmail } from "../api/auth";
import { authLoginUrl } from "../api/http";

interface Props {
  navigate: (to: Page) => void;
}

export default function Landing({ navigate }: Props) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): string | null {
    const normalizedEmail = email.trim();
    if (mode === "signup" && !fullName.trim()) return "Full name is required.";
    if (!normalizedEmail) return "Email is required.";
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) return "Please enter a valid email address.";
    if (!password) return "Password is required.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (mode === "signup" && password !== confirmPassword) return "Passwords do not match.";
    return null;
  }

  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload =
        mode === "signup"
          ? await signupEmail({
              name: fullName.trim(),
              email: email.trim().toLowerCase(),
              password,
            })
          : await loginEmail({
              email: email.trim().toLowerCase(),
              password,
            });
      localStorage.setItem("mailSherlockAuthToken", payload.token);
      navigate("dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.");
    } finally {
      setSubmitting(false);
    }
  }

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
          <div className="ls-tabs">
            <button
              className={`ls-tab ${mode === "login" ? "active" : ""}`}
              onClick={() => setMode("login")}
              type="button"
            >
              Login
            </button>
            <button
              className={`ls-tab ${mode === "signup" ? "active" : ""}`}
              onClick={() => setMode("signup")}
              type="button"
            >
              Sign up
            </button>
          </div>

          <p className="ls-card-title">{mode === "login" ? "Welcome back" : "Create your account"}</p>
          <p className="ls-card-sub">
            {mode === "login"
              ? "Sign in to continue your email investigations."
              : "Set up Mail Sherlock in less than a minute."}
          </p>

          <button className="ls-google-btn" onClick={() => (window.location.href = authLoginUrl())}>
            Continue with Google
          </button>

          <div className="ls-divider">OR USE EMAIL</div>

          <form
            className="ls-form"
            onSubmit={handleEmailAuth}
          >
            {mode === "signup" && (
              <label className="ls-input-wrap">
                <span>Full name</span>
                <input
                  type="text"
                  placeholder="Ada Lovelace"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </label>
            )}
            <label className="ls-input-wrap">
              <span>Email</span>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="ls-input-wrap">
              <span>Password</span>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {mode === "signup" && (
              <label className="ls-input-wrap">
                <span>Confirm password</span>
                <input
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </label>
            )}
            {error && <p className="ls-form-error">{error}</p>}
            <button className="ls-submit-btn" type="submit">
              {submitting ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          <p className="ls-privacy">
            Your emails are indexed <strong>locally on your machine</strong>. We
            never send your inbox content to third-party servers.
          </p>
        </div>
        <p className="ls-footer">CS4800 class project · Mail Sherlock</p>
      </section>
    </div>
  );
}
