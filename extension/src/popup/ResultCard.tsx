import { EmailResult } from "../api/search";

interface Props {
  email: EmailResult;
}

export default function ResultCard({ email }: Props) {
  const scorePercent = Math.round(email.score * 100);

  return (
    <div className="result-card">
      <div className="result-header">
        <span className="subject">{email.subject}</span>
        <span className="score">{scorePercent}%</span>
      </div>
      <div className="meta">
        <span className="sender">{email.sender}</span>
        <span className="date">{email.date}</span>
      </div>
      <p className="snippet">{email.body.slice(0, 120)}...</p>
    </div>
  );
}
