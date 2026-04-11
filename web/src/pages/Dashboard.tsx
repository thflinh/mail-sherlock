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


export default function Dashboard({ navigate }: Props) {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  // activeChip: account-scope selection ("All accounts" or a specific email)
  const [activeChip, setActiveChip] = useState("All accounts");
  // activeFilters: stackable toggles ("Has attachment", "Unread only")
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [starredIds, setStarredIds] = useState<Set<number>>(new Set());
  const [avatarOpen, setAvatarOpen] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const msgIdRef = useRef(0);

  const [gmailEmail, setGmailEmail] = useState<string | null>(null);
  /** Connected accounts (order = connection order; [0] is primary for greetings). */
  const [accounts, setAccounts] = useState<string[]>([]);
  const [emailCount, setEmailCount] = useState(0);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncNeedsReauth, setSyncNeedsReauth] = useState(false);
  const [syncDone, setSyncDone] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  function applyStatusPayload(d: {
    accounts?: string[];
    gmailAuthEmail?: string | null;
    emailCount?: number;
  }) {
    const list: string[] = Array.isArray(d.accounts)
      ? d.accounts
      : d.gmailAuthEmail
        ? [d.gmailAuthEmail]
        : [];
    setAccounts(list);
    setGmailEmail(d.gmailAuthEmail ?? list[0] ?? null);
    setEmailCount(d.emailCount ?? 0);
  }

  useEffect(() => {
    fetch("/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => applyStatusPayload(d))
      .catch(() => {})
      .finally(() => setStatusLoaded(true));
  }, []);

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState !== "visible") return;
      fetch("/status", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => applyStatusPayload(d))
        .catch(() => {});
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const primaryEmail = accounts[0] ?? gmailEmail;

  useEffect(() => {
    if (!statusLoaded) return;
    const name = primaryEmail ? primaryEmail.split("@")[0].split(".")[0] : null;
    setMessages([
      {
        id: ++msgIdRef.current,
        role: "ai",
        content: name
          ? `Hi ${name}! I'm your Sherlock assistant. Describe any email you're looking for and I'll find it across your connected accounts.`
          : "Connect your Gmail account to start searching your emails by meaning — not just keywords.",
        suggestions: undefined,
        time: nowTime(),
      },
    ]);
  }, [statusLoaded, primaryEmail]);

  useEffect(() => {
    if (activeChip !== "All accounts" && !accounts.includes(activeChip)) {
      setActiveChip("All accounts");
    }
  }, [accounts, activeChip]);

  function scrollToBottom() {
    setTimeout(() => {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
    }, 50);
  }

  function formatEmailDate(raw: string | undefined): string {
    if (!raw) return "";
    try {
      const d = new Date(raw);
      if (isNaN(d.getTime())) return raw;
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return raw;
    }
  }

  function toggleFilter(filter: string) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });
  }

  function toggleStar(id: number) {
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    setSyncNeedsReauth(false);
    setSyncDone(false);
    try {
      const res = await fetch("/emails/sync", { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (res.status === 401) {
          setSyncNeedsReauth(true);
          return;
        }
        throw new Error(d.detail ?? `Server error ${res.status}`);
      }
      const d = await res.json();
      setEmailCount(d.total ?? d.synced ?? 0);
      if (Array.isArray(d.accounts) && d.accounts.length > 0) {
        setAccounts(d.accounts);
      } else if (d.perAccount && typeof d.perAccount === "object") {
        const keys = Object.keys(d.perAccount as Record<string, unknown>);
        if (keys.length > 0) setAccounts(keys);
      }
      if (d.gmailAddress) setGmailEmail(d.gmailAddress);
      else if (Array.isArray(d.accounts) && d.accounts[0]) setGmailEmail(d.accounts[0]);
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
        body: JSON.stringify({
          messages: historyForApi,
          top_k: 5,
          filters: {
            has_attachment: activeFilters.has("Has attachment"),
            unread_only: activeFilters.has("Unread only"),
            ...(activeChip !== "All accounts" && accounts.includes(activeChip)
              ? { account_email: activeChip }
              : {}),
          },
        }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data: SearchResponse = await res.json();
      if (Array.isArray(data.accounts) && data.accounts.length > 0) {
        setAccounts(data.accounts);
        setGmailEmail(data.gmailAuthEmail ?? data.accounts[0] ?? null);
      } else if (data.gmailAuthEmail) {
        setGmailEmail(data.gmailAuthEmail);
      }

      const rawResults = data.results ?? [];
      const results: EmailResult[] = rawResults.map((r) => {
        const row = r as EmailResult & { sender?: string; accountEmail?: string };
        const sender = String(row.sender ?? row.from ?? "");
        const acct = String(row.accountEmail ?? row.account ?? "").trim();
        return {
          id: String(row.id ?? ""),
          from: sender,
          subject: String(row.subject ?? ""),
          snippet: String(row.snippet ?? ""),
          date: row.date != null ? String(row.date) : undefined,
          score: row.score != null ? Math.round(Number(row.score) * 100) : undefined,
          account: acct || undefined,
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
    const name = primaryEmail ? primaryEmail.split("@")[0].split(".")[0] : null;
    setMessages([
      {
        id: ++msgIdRef.current,
        role: "ai",
        content: name
          ? `New conversation started. What email are you looking for, ${name}?`
          : "New conversation. Connect your Gmail to start searching.",
        suggestions: undefined,
        time: nowTime(),
      },
    ]);
  }

  const userInitials = primaryEmail ? initials(primaryEmail) : "?";
  const firstName = primaryEmail ? primaryEmail.split("@")[0].split(".")[0] : "there";
  const accountCount = accounts.length > 0 ? accounts.length : primaryEmail ? 1 : 0;

  // Account chips are mutually exclusive; Has attachment / Unread only stack on top
  const accountChips: string[] = ["All accounts", ...accounts];
  const OPTION_CHIPS = ["Has attachment", "Unread only"];

  const topbarLine = (() => {
    if (!primaryEmail) return "Connect Gmail to get started";
    if (emailCount === 0 && !syncDone)
      return `${accounts.length > 1 ? `${accounts.length} accounts` : primaryEmail} · Sync your inbox to index emails`;
    const parts = [
      `${emailCount.toLocaleString()} emails indexed`,
      `${accountCount} account${accountCount === 1 ? "" : "s"}`,
    ];
    if (lastSyncedAt) parts.push(`Last synced ${formatRelativeTime(lastSyncedAt)}`);
    else if (syncDone) parts.push("Last synced just now");
    return parts.join(" · ");
  })();

  function formatContent(text: string) {
    return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  const canSearch = statusLoaded && !!primaryEmail;
  const sendDisabled = !query.trim() || typing || !canSearch;
  const connected = accounts.length > 0 || !!primaryEmail;

  return (
    <div className="db">
      <nav className="db-nav">
        <div className="db-nav-left">
          <div className="db-logo">
            <img src={iconUrl} alt="" width={30} height={30} style={{ objectFit: "contain" }} />
            Mail Sherlock
          </div>
          <div className="db-nav-links">
            <span className="db-nav-link active">Dashboard</span>
            <span className="db-nav-link">Accounts</span>
            <span className="db-nav-link">Insights</span>
            <span className="db-nav-link">Settings</span>
          </div>
        </div>
        <div className="db-nav-right">
          {connected ? (
            <a
              href="/auth/login"
              className="db-btn-add-mailbox"
              title="Sign in with another Google account in the browser"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Add mailbox
            </a>
          ) : (
            <a href="/auth/login" className="db-btn-connect">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <line x1="6" y1="1" x2="6" y2="11" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
                <line x1="1" y1="6" x2="11" y2="6" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Connect Gmail
            </a>
          )}
          <div className="db-avatar-wrap">
            <button
              type="button"
              className="db-avatar"
              onClick={() => setAvatarOpen((o) => !o)}
              aria-label="Account menu"
            >
              {userInitials}
            </button>
            {avatarOpen && (
              <div className="db-avatar-menu" onMouseLeave={() => setAvatarOpen(false)}>
                <div className="db-avatar-menu-h">Connected mailboxes</div>
                {accounts.length === 0 ? (
                  <div className="db-avatar-email db-avatar-email-empty">No Gmail linked yet</div>
                ) : (
                  accounts.map((a) => (
                    <div key={a} className="db-avatar-email" title={a}>
                      {a}
                    </div>
                  ))
                )}
                <div className="db-avatar-divider" />
                <a href="/auth/login" className="db-avatar-item" onClick={() => setAvatarOpen(false)}>
                  Add or manage Gmail
                </a>
                <button
                  type="button"
                  className="db-avatar-item db-avatar-signout"
                  onClick={() => { setAvatarOpen(false); navigate("landing"); }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <div className="db-layout">
        <aside className="db-sidebar">
          <div className="db-sidebar-section db-sidebar-accounts">
            <div className="db-sidebar-label">Accounts</div>
            {accounts.length > 0 ? (
              <>
                {accounts.map((acc) => (
                  <div key={acc} className="db-acc-item" title={acc}>
                    <div className="db-acc-dot" style={{ background: "#34A853" }} />
                    <div className="db-acc-name">{acc}</div>
                    {accounts.length === 1 && emailCount > 0 && (
                      <div className="db-acc-count">{emailCount.toLocaleString()}</div>
                    )}
                  </div>
                ))}
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
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                        <path d="M10 6A4 4 0 1 1 6 2" stroke="#9B72CF" strokeWidth="1.5" strokeLinecap="round" />
                        <path d="M6 2l2-2M6 2l2 2" stroke="#9B72CF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {syncDone ? "Re-sync all" : "Sync inboxes"}
                    </>
                  )}
                </button>
                {syncDone && (
                  <div className="db-sync-ok">
                    {emailCount.toLocaleString()} indexed across {accountCount}{" "}
                    {accountCount === 1 ? "account" : "accounts"}
                  </div>
                )}
                {syncNeedsReauth && (
                  <div className="db-sync-reauth">
                    Session expired —{" "}
                    <a href="/auth/login" className="db-sync-reauth-link">
                      reconnect Gmail
                    </a>
                  </div>
                )}
                {syncError && <div className="db-sync-err">{syncError}</div>}
              </>
            ) : (
              <div className="db-acc-empty">Connect a Gmail account to index your mail.</div>
            )}
            <a href="/auth/login" className="db-add-acc">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <line x1="6" y1="1" x2="6" y2="11" stroke="#9B72CF" strokeWidth="1.6" strokeLinecap="round" />
                <line x1="1" y1="6" x2="11" y2="6" stroke="#9B72CF" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              {accounts.length > 0 ? "Add another mailbox" : "Add Gmail account"}
            </a>
          </div>

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
              {accountChips.map((chip) => (
                <div
                  key={chip}
                  className={`db-chip${activeChip === chip ? " active" : ""}${chip.includes("@") ? " db-chip-mail" : ""}`}
                  onClick={() => setActiveChip(chip)}
                  onKeyDown={(e) => e.key === "Enter" && setActiveChip(chip)}
                  role="button"
                  tabIndex={0}
                  title={chip.includes("@") ? chip : undefined}
                >
                  <span className="db-chip-label">{chip}</span>
                </div>
              ))}
              <div className="db-chip-divider" />
              {OPTION_CHIPS.map((chip) => (
                <div
                  key={chip}
                  className={`db-chip${activeFilters.has(chip) ? " active" : ""}`}
                  onClick={() => toggleFilter(chip)}
                  onKeyDown={(e) => e.key === "Enter" && toggleFilter(chip)}
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
                        const acct = r.account ?? "";
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
                              <span className="db-rc-date">{formatEmailDate(r.date)}</span>
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
                              {gmailLink && (
                                <span className="db-rc-gmail-link">Open in Gmail →</span>
                              )}
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
                  <div className="db-bubble-foot">
                    <span className="db-bubble-ts">{msg.time}</span>
                    {msg.role === "ai" && (
                      <button
                        type="button"
                        className={`db-star-btn${starredIds.has(msg.id) ? " starred" : ""}`}
                        onClick={() => toggleStar(msg.id)}
                        aria-label={starredIds.has(msg.id) ? "Remove bookmark" : "Bookmark this response"}
                        title={starredIds.has(msg.id) ? "Remove bookmark" : "Bookmark"}
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                          <path d="M8 2l1.5 3.5L13 6l-2.5 2.5.5 3.5L8 10.5 5 12l.5-3.5L3 6l3.5-.5z"
                            stroke="currentColor" strokeWidth="1.3"
                            fill={starredIds.has(msg.id) ? "currentColor" : "none"} />
                        </svg>
                      </button>
                    )}
                  </div>
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
                    : "Connect Gmail (top right) to search your mail…"
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
                ? activeChip === "All accounts"
                  ? `mail-sherlock searches across ${accountCount} account${accountCount === 1 ? "" : "s"} · results ranked by semantic similarity`
                  : `mail-sherlock searches as ${activeChip} · results ranked by semantic similarity`
                : "Connect an account to search across your indexed mail"}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
