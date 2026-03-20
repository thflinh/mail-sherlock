import { EmailResult, gmailWebUrlForThread } from "../api/search";

interface Props {
  email: EmailResult;
  /** From API after Gmail sync — links open that Google account, not Chrome’s first profile slot. */
  gmailAuthEmail: string | null;
}

export default function ResultCard({ email, gmailAuthEmail }: Props) {
  const scorePercent = Math.round(email.score * 100);
  const threadId = email.threadId?.trim();
  const gmailUrl =
    threadId && gmailAuthEmail?.trim()
      ? gmailWebUrlForThread(threadId, gmailAuthEmail)
      : null;

  const inner = (
    <>
      <div className="result-header">
        <span className="subject">{email.subject}</span>
        <span className="score">{scorePercent}%</span>
      </div>
      <div className="meta">
        <span className="sender">{email.sender}</span>
        <span className="date">{email.date}</span>
      </div>
      <p className="snippet">{email.body.slice(0, 120)}...</p>
      {gmailUrl && (
        <span className="open-gmail-hint">Open in Gmail</span>
      )}
      {threadId && !gmailUrl && (
        <span className="open-gmail-hint open-gmail-hint--muted">
          Re-run POST /emails/sync to open threads in your OAuth Gmail account.
        </span>
      )}
    </>
  );

  if (gmailUrl) {
    return (
      <a
        className="result-card result-card--link"
        href={gmailUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open in Gmail as ${gmailAuthEmail ?? ""}`}
      >
        {inner}
      </a>
    );
  }

  return <div className="result-card">{inner}</div>;
}
