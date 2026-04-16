import type { EmailResult } from "../types";

const TAG_COLORS = [
  { bg: "#DCE9FF", color: "#2563EB" },
  { bg: "#E9E8FF", color: "#4C45C5" },
  { bg: "#EDF3FF", color: "#3B6FCA" },
];

function scoreBarColor(score: number): string {
  if (score >= 90) return "#6F6AEF";
  if (score >= 75) return "#5B8DEF";
  return "#C9D6EA";
}

export function initials(from: string): string {
  const name = from.split("@")[0].replace(/[._-]/g, " ");
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

interface Props {
  result: EmailResult;
  gmailEmail: string | null;
}

export default function ResultCard({ result: r, gmailEmail }: Props) {
  const ini = r.initials ?? initials(r.from ?? "");
  const abg = r.avatarBg ?? "#DCE9FF";
  const aclr = r.avatarColor ?? "#2563EB";
  const score = typeof r.score === "number" ? r.score : null;
  const barColor = score != null ? scoreBarColor(score) : "#C9D6EA";
  const tags = r.tags ?? [];

  const gmailLink =
    r.id && gmailEmail
      ? `https://mail.google.com/mail/u/0/#inbox/${r.id}`
      : null;

  return (
    <a
      className="result-card"
      href={gmailLink ?? "#"}
      target={gmailLink ? "_blank" : undefined}
      rel="noopener noreferrer"
      onClick={gmailLink ? undefined : (e) => e.preventDefault()}
    >
      <div className="score-bar" style={{ background: barColor }} />
      <div className="result-avatar" style={{ background: abg, color: aclr }}>
        {ini}
      </div>
      <div className="result-body">
        <div className="result-top">
          <span className="result-from">{r.from}</span>
          <span className="result-meta">
            {r.date}
            {r.account && <> &middot; {r.account}</>}
          </span>
        </div>
        <div className="result-subject">{r.subject}</div>
        <div className="result-snippet">{r.snippet}</div>
        <div className="result-footer">
          {tags.map((t, i) => {
            const tc =
              typeof t === "string"
                ? TAG_COLORS[i % TAG_COLORS.length]
                : { bg: t.bg, color: t.color };
            const label = typeof t === "string" ? t : t.label;
            return (
              <span
                key={i}
                className="tag"
                style={{ background: tc.bg, color: tc.color }}
              >
                {label}
              </span>
            );
          })}
          {score != null && <span className="match-pct">{score}% match</span>}
        </div>
      </div>
    </a>
  );
}
