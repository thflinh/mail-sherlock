import { useState, useEffect, useRef } from "react";
import "./Dashboard.css";
import type { Page } from "../App";
import iconUrl from "../assets/icon.png";
import type { EmailResult, SearchResponse } from "../types";

interface Props {
  navigate: (to: Page) => void;
}

type Suggestion = { label: string; query: string };

type Message = {
  id: number;
  role: "user" | "ai";
  content: string;
  results?: EmailResult[];
  suggestions?: Suggestion[];
  time: string;
};

function initials(from: string): string {
  const name = from.split("@")[0].replace(/[._-]/g, " ");
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function stripForApi(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function greetingForHour(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function formatRelativeTime(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString();
}

const LABELS = [
  { name: "Housing", dot: "#F0C4DC" },
  { name: "Finance", dot: "#B5D4F4" },
  { name: "Work", dot: "#9FE1CB" },
  { name: "School", dot: "#FAC775" },
];

const GREETING_SUGGESTIONS: Suggestion[] = [
  { label: "Lease renewal", query: "email about my lease renewal" },
  { label: "Invoice / payment", query: "invoice or payment confirmation" },
  { label: "School deadline", query: "professor deadline or assignment" },
  { label: "Job offer", query: "job offer or interview" },
];

export default function Dashboard({ navigate }: Props) {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [activeChip, setActiveChip] = useState("All accounts");
  const chatRef = useRef<HTMLDivElement>(null);
  const msgIdRef = useRef(0);

  const [gmailEmail, setGmailEmail] = useState<string | null>(null);
  const [emailCount, setEmailCount] = useState(0);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncDone, setSyncDone] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  useEffect(() => {
    fetch("/status")
      .then((r) => r.json())
      .then((d) => {
        setGmailEmail(d.gmailAuthEmail ?? null);
        setEmailCount(d.emailCount ?? 0);
      })
      .catch(() => {})
      .finally(() => setStatusLoaded(true));
  }, []);

  useEffect(() => {
    if (!statusLoaded) return;
    const name = gmailEmail ? gmailEmail.split("@")[0].split(".")[0] : null;
    setMessages([
      {
        id: ++msgIdRef.current,
        role: "ai",
        content: name
          ? `Hi ${name}! I'm your Smart Inbox assistant. Describe any email you're looking for and I'll find it across your connected accounts.`
          : "Connect your Gmail account to start searching your emails by meaning — not just keywords.",
        suggestions: gmailEmail ? GREETING_SUGGESTIONS : undefined,
        time: nowTime(),
      },
    ]);
    // Intentionally once when /status has loaded — avoid wiping chat when gmailEmail updates later.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gmailEmail is read on first paint after load
  }, [statusLoaded]);

  function scrollToBottom() {
    setTimeout(() => {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
    }, 50);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    setSyncDone(false);
    try {
      const res = await fetch("/emails/sync", { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail ?? `Server error ${res.status}`);
      }
      const d = await res.json();
      setEmailCount(d.synced ?? 0);
      if (d.gmailAddress) setGmailEmail(d.gmailAddress);
      setSyncDone(true);
      setLastSyncedAt(new Date());
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  async function sendMessage(text?: string) {
    const msg = (text ?? query).trim();
    if (!msg || typing) return;
    setQuery("");

    setMessages((prev) => [
      ...prev,
      { id: ++msgIdRef.current, role: "user", content: msg, time: nowTime() },
    ]);
    scrollToBottom();
    setTyping(true);

    const historyForApi = [
      ...messages.map((m) => ({
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content: m.role === "user" ? m.content : stripForApi(m.content),
      })),
      { role: "user" as const, content: msg },
    ];

    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyForApi, top_k: 5 }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data: SearchResponse = await res.json();
      if (data.gmailAuthEmail) setGmailEmail(data.gmailAuthEmail);

      const accountEmail = data.gmailAuthEmail ?? gmailEmail ?? "";

      const rawResults = data.results ?? [];
      const results: EmailResult[] = rawResults.map((r) => {
        const row = r as EmailResult & { sender?: string };
        const sender = String(row.sender ?? row.from ?? "");
        return {
          id: String(row.id ?? ""),
          from: sender,
          subject: String(row.subject ?? ""),
          snippet: String(row.snippet ?? ""),
          date: row.date != null ? String(row.date) : undefined,
          score: row.score != null ? Math.round(Number(row.score) * 100) : undefined,
          account: accountEmail || undefined,
          tags: row.tags,
          initials: initials(sender),
          avatarBg: "#F0C4DC",
          avatarColor: "#72243E",
        };
      });

      const count = results.length;
      const replyLine =
        typeof data.reply === "string" && data.reply.trim()
          ? data.reply.trim()
          : count > 0
            ? `I found **${count}** email${count === 1 ? "" : "s"} that match. Here are the top results:`
            : "I couldn't find any emails matching that description. Try rephrasing or adding more details.";

      setMessages((prev) => [
        ...prev,
        {
          id: ++msgIdRef.current,
          role: "ai",
          content: replyLine,
          results: count > 0 ? results : undefined,
          suggestions:
            count > 0
              ? [
                  { label: "Filter attachments", query: "Show only emails with attachments" },
                  { label: "Narrow by date", query: "Emails from the last month" },
                  { label: "New search", query: "Search for a different email" },
                ]
              : [
                  { label: "Try different wording", query: "invoice or receipt from last month" },
                  { label: "Search by sender", query: "emails from my bank" },
                  { label: "New search", query: "Search for a different email" },
                ],
          time: nowTime(),
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: ++msgIdRef.current,
          role: "ai",
          content: err instanceof Error ? err.message : "Something went wrong. Please try again.",
          time: nowTime(),
        },
      ]);
    } finally {
      setTyping(false);
      scrollToBottom();
    }
  }

  function clearChat() {
    const name = gmailEmail ? gmailEmail.split("@")[0].split(".")[0] : null;
    setMessages([
      {
        id: ++msgIdRef.current,
        role: "ai",
        content: name
          ? `New conversation started. What email are you looking for, ${name}?`
          : "New conversation. Connect your Gmail to start searching.",
        suggestions: gmailEmail ? GREETING_SUGGESTIONS : undefined,
        time: nowTime(),
      },
    ]);
  }

  const setupStep = !statusLoaded ? 0 : !gmailEmail ? 1 : emailCount === 0 ? 2 : 3;
  const userInitials = gmailEmail ? initials(gmailEmail) : "?";
  const firstName = gmailEmail ? gmailEmail.split("@")[0].split(".")[0] : "there";
  const accountCount = gmailEmail ? 1 : 0;

  const filterChips: string[] = [
    "All accounts",
    ...(gmailEmail ? [gmailEmail] : []),
    "Has attachment",
    "Unread only",
  ];

  const topbarLine = (() => {
    if (!gmailEmail) return "Connect Gmail to get started";
    if (emailCount === 0 && !syncDone)
      return `${gmailEmail} · Sync your inbox to index emails`;
    const parts = [`${emailCount.toLocaleString()} emails indexed`, `${accountCount} account`];
    if (lastSyncedAt) parts.push(`Last synced ${formatRelativeTime(lastSyncedAt)}`);
    else if (syncDone) parts.push("Last synced just now");
    return parts.join(" · ");
  })();

  function formatContent(text: string) {
    return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  const canSearch = statusLoaded && !!gmailEmail;
  const sendDisabled = !query.trim() || typing || !canSearch;
  const connected = !!gmailEmail;

  return (
    <div className="db">
      <nav className="db-nav">
        <div className="db-nav-left">
          <div className="db-logo">
            <img src={iconUrl} alt="" width={30} height={30} style={{ objectFit: "contain" }} />
            mail-sherlock
          </div>
          <div className="db-nav-links">
            <span className="db-nav-link active">Dashboard</span>
            <span className="db-nav-link">Accounts</span>
            <span className="db-nav-link">Insights</span>
            <span className="db-nav-link">Settings</span>
          </div>
        </div>
        <div className="db-nav-right">
          {setupStep < 3 && (
            <a href="/auth/login" className="db-btn-connect">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <line x1="6" y1="1" x2="6" y2="11" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
                <line x1="1" y1="6" x2="11" y2="6" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Connect account
            </a>
          )}
          <button type="button" className="db-avatar" onClick={() => navigate("landing")}>
            {userInitials}
          </button>
        </div>
      </nav>

      <div className="db-layout">
        <aside className="db-sidebar">
          <div className="db-sidebar-section">
            <div className="db-sidebar-label">Menu</div>
            {[
              {
                label: "Search",
                active: true,
                icon: (
                  <>
                    <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4" />
                    <line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </>
                ),
              },
              {
                label: "All emails",
                active: false,
                icon: (
                  <>
                    <rect x="2" y="3" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M5 7h6M5 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </>
                ),
              },
              {
                label: "Starred",
                active: false,
                icon: (
                  <path d="M8 2l1.5 3.5L13 6l-2.5 2.5.5 3.5L8 10.5 5 12l.5-3.5L3 6l3.5-.5z" stroke="currentColor" strokeWidth="1.2" fill="none" />
                ),
              },
              {
                label: "Attachments",
                active: false,
                icon: (
                  <>
                    <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M5 8h6M5 5h6M5 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </>
                ),
              },
            ].map((item) => (
              <div key={item.label} className={`db-sidebar-item${item.active ? " active" : ""}`}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  {item.icon}
                </svg>
                {item.label}
              </div>
            ))}
          </div>

          <div className="db-sidebar-section">
            <div className="db-sidebar-label">Labels</div>
            {LABELS.map((l) => (
              <div key={l.name} className="db-sidebar-item">
                <span className="db-label-dot" style={{ background: l.dot }} />
                {l.name}
              </div>
            ))}
          </div>

          <div className="db-sidebar-section">
            <div className="db-sidebar-label">Accounts</div>
            {gmailEmail ? (
              <>
                <div className="db-acc-item">
                  <div className="db-acc-dot" style={{ background: "#34A853" }} />
                  <div className="db-acc-name">{gmailEmail}</div>
                  {emailCount > 0 && <div className="db-acc-count">{emailCount.toLocaleString()}</div>}
                </div>
                <button type="button" className="db-sync-btn" onClick={handleSync} disabled={syncing}>
                  {syncing ? (
                    <>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="db-spin">
                        <circle cx="6" cy="6" r="4.5" stroke="#9B72CF" strokeWidth="1.5" strokeDasharray="14 8" />
                      </svg>
                      Syncing…
                    </>
                  ) : (
                    <>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M10 6A4 4 0 1 1 6 2" stroke="#9B72CF" strokeWidth="1.5" strokeLinecap="round" />
                        <path d="M6 2l2-2M6 2l2 2" stroke="#9B72CF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {syncDone ? "Re-sync emails" : "Sync emails"}
                    </>
                  )}
                </button>
                {syncDone && <div className="db-sync-ok">{emailCount.toLocaleString()} emails indexed</div>}
                {syncError && <div className="db-sync-err">{syncError}</div>}
              </>
            ) : (
              <a href="/auth/login" className="db-add-acc">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <line x1="6" y1="1" x2="6" y2="11" stroke="#9B72CF" strokeWidth="1.6" strokeLinecap="round" />
                  <line x1="1" y1="6" x2="11" y2="6" stroke="#9B72CF" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                Add account
              </a>
            )}
          </div>

          {connected && (
            <div className="db-sidebar-section">
              <div className="db-sidebar-label">Stats</div>
              <div className="db-stat-mini">
                <div className="db-sm">
                  <div className="db-sm-n">{emailCount.toLocaleString()}</div>
                  <div className="db-sm-l">Indexed</div>
                </div>
                <div className="db-sm">
                  <div className="db-sm-n">{accountCount}</div>
                  <div className="db-sm-l">Accounts</div>
                </div>
                <div className="db-sm db-sm-muted">
                  <div className="db-sm-n">—</div>
                  <div className="db-sm-l">Unread</div>
                </div>
                <div className="db-sm db-sm-muted">
                  <div className="db-sm-n">—</div>
                  <div className="db-sm-l">Attachments</div>
                </div>
              </div>
            </div>
          )}
        </aside>

        <main className="db-main">
          <div className="db-topbar">
            <div className="db-topbar-row">
              <div>
                <h1 className="db-topbar-h1">
                  {greetingForHour()}, {firstName}
                </h1>
                <p className="db-topbar-sub">{topbarLine}</p>
              </div>
              <button type="button" className="db-new-conv" onClick={clearChat}>
                New conversation
              </button>
            </div>
            <div className="db-chips">
              {filterChips.map((chip) => (
                <div
                  key={chip}
                  className={`db-chip${activeChip === chip ? " active" : ""}`}
                  onClick={() => setActiveChip(chip)}
                  onKeyDown={(e) => e.key === "Enter" && setActiveChip(chip)}
                  role="button"
                  tabIndex={0}
                >
                  {chip}
                </div>
              ))}
            </div>
          </div>

          <div className="db-chat-area" ref={chatRef}>
            {messages.map((msg) => (
              <div key={msg.id} className={`db-msg-row${msg.role === "user" ? " user" : ""}`}>
                {msg.role === "ai" && (
                  <div className="db-msg-avatar ai-av">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M8 2l1.2 2.8L12 5.5l-2.2 2.1.6 3L8 9.2 5.6 10.6l.6-3L4 5.5l2.8-.7z" fill="#9B72CF" />
                    </svg>
                  </div>
                )}
                <div className={`db-bubble ${msg.role}`}>
                  <span dangerouslySetInnerHTML={{ __html: formatContent(msg.content) }} />

                  {msg.results && msg.results.length > 0 && (
                    <div className="db-rc-list">
                      {msg.results.map((r) => {
                        const score = r.score ?? 0;
                        const tags = r.tags ?? [];
                        const gmailLink = r.id ? `https://mail.google.com/mail/u/0/#inbox/${r.id}` : null;
                        const acct = r.account ?? gmailEmail ?? "";
                        return (
                          <a
                            key={r.id}
                            className="db-rc"
                            href={gmailLink ?? "#"}
                            target={gmailLink ? "_blank" : undefined}
                            rel="noopener noreferrer"
                            onClick={gmailLink ? undefined : (e) => e.preventDefault()}
                          >
                            <div className="db-rc-top">
                              <span className="db-rc-from">{r.from}</span>
                              <span className="db-rc-date">{r.date ?? ""}</span>
                            </div>
                            <div className="db-rc-subj">{r.subject}</div>
                            <div className="db-rc-snip">{r.snippet}</div>
                            <div className="db-rc-foot">
                              {tags.map((t, i) => (
                                <span key={i} className="db-rc-tag" style={{ background: t.bg, color: t.color }}>
                                  {t.label}
                                </span>
                              ))}
                              {acct && (
                                <span className="db-rc-acc">
                                  <span className="db-rc-dot" style={{ background: "#34A853" }} />
                                  {acct}
                                </span>
                              )}
                              {score > 0 && <span className="db-rc-score">{score}% match</span>}
                            </div>
                          </a>
                        );
                      })}
                    </div>
                  )}

                  {msg.suggestions && (
                    <div className="db-suggestions">
                      {msg.suggestions.map((s) => (
                        <span key={s.label} className="db-sug" onClick={() => sendMessage(s.query)}>
                          {s.label}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="db-bubble-ts">{msg.time}</div>
                </div>
                {msg.role === "user" && <div className="db-msg-avatar user-av">{userInitials}</div>}
              </div>
            ))}

            {typing && (
              <div className="db-msg-row">
                <div className="db-msg-avatar ai-av">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M8 2l1.2 2.8L12 5.5l-2.2 2.1.6 3L8 9.2 5.6 10.6l.6-3L4 5.5l2.8-.7z" fill="#9B72CF" />
                  </svg>
                </div>
                <div className="db-bubble ai" style={{ padding: 0 }}>
                  <div className="db-typing">
                    <div className="db-tdot" />
                    <div className="db-tdot" />
                    <div className="db-tdot" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="db-input-bar">
            <div className="db-input-wrap">
              <button className="db-mic-btn" type="button" aria-label="Voice input (not connected)">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="5" y="1" width="6" height="9" rx="3" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M2 8c0 3.3 2.7 6 6 6s6-2.7 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
                  <line x1="8" y1="14" x2="8" y2="15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
              <input
                type="text"
                placeholder={
                  canSearch
                    ? "Ask me to find an email, or ask a follow-up…"
                    : "Connect Gmail in the header to search…"
                }
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendMessage();
                }}
                disabled={!canSearch}
              />
              <button className="db-send-btn" type="button" onClick={() => sendMessage()} disabled={sendDisabled}>
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <path d="M13 7.5L2 2l2.5 5.5L2 13z" fill="white" />
                </svg>
              </button>
            </div>
            <div className="db-input-hint">
              {connected
                ? `mail-sherlock searches ${gmailEmail ? `as ${gmailEmail}` : "your inbox"} · results ranked by semantic similarity`
                : "Connect an account to search across your indexed mail"}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
