import { useState, useEffect, useRef } from "react";
import "./Dashboard.css";
import type { Page } from "../App";
import iconUrl from "../assets/icon.png";
import type { AgentMode, EmailDetail, EmailResult, SearchResponse } from "../types";
import { createEvent, deleteEvent, getEvents, type CalendarEvent } from "../api/events";
import { getAccounts, switchAccount } from "../api/accounts";
import { logoutSession } from "../api/auth";
import { authHeaders, authLoginUrl } from "../api/http";
import type { Account } from "../types";

interface Props {
  navigate: (to: Page) => void;
}

type Suggestion = { label: string; query: string };
type SidebarTab = "search" | "calendar" | "history";

type Message = {
  id: number;
  role: "user" | "ai";
  content: string;
  results?: EmailResult[];
  suggestions?: Suggestion[];
  mode?: AgentMode;
  time: string;
};

function initials(from: string): string {
  const name = from.split("@")[0].replace(/[._-]/g, " ");
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
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

const FILTER_CHIPS = ["All", "Has attachment", "Unread", "Last 30 days"] as const;
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function eventColor(source: CalendarEvent["source"]) {
  return source === "from_email" ? "#9B72CF" : "#185FA5";
}

export default function Dashboard({ navigate }: Props) {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set(["All"]));
  // openEmailId: email currently open in the in-app reader panel
  const [openEmailId, setOpenEmailId] = useState<string | null>(null);
  const [readerEmail, setReaderEmail] = useState<EmailDetail | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const msgIdRef = useRef(0);

  const [gmailEmail, setGmailEmail] = useState<string | null>(null);
  /** Connected accounts (order = connection order; [0] is primary for greetings). */
  const [accounts, setAccounts] = useState<string[]>([]);
  const [emailCount, setEmailCount] = useState(0);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [, setSyncError] = useState<string | null>(null);
  const [, setSyncNeedsReauth] = useState(false);
  const [syncDone, setSyncDone] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [switchModalOpen, setSwitchModalOpen] = useState(false);
  const [accountDetails, setAccountDetails] = useState<Account[]>([]);
  const [activeAccount, setActiveAccount] = useState<string | null>(null);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("search");
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [showAddEventModal, setShowAddEventModal] = useState(false);
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventTime, setEventTime] = useState("");
  const [eventDescription, setEventDescription] = useState("");
  const [eventSaving, setEventSaving] = useState(false);
  const [eventSaveError, setEventSaveError] = useState<string | null>(null);

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
    const primary = d.gmailAuthEmail ?? list[0] ?? null;
    setGmailEmail(primary);
    setActiveAccount((prev) => prev ?? primary);
    setEmailCount(d.emailCount ?? 0);
  }

  useEffect(() => {
    fetch("/status", { cache: "no-store", headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => applyStatusPayload(d))
      .catch(() => {})
      .finally(() => setStatusLoaded(true));
  }, []);

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState !== "visible") return;
      fetch("/status", { cache: "no-store", headers: authHeaders() })
        .then((r) => r.json())
        .then((d) => applyStatusPayload(d))
        .catch(() => {});
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  async function loadCalendarEvents() {
    setCalendarLoading(true);
    setCalendarError(null);
    try {
      const events = await getEvents();
      setCalendarEvents(events);
    } catch (err) {
      setCalendarError(err instanceof Error ? err.message : "Failed to load events.");
    } finally {
      setCalendarLoading(false);
    }
  }

  useEffect(() => {
    loadCalendarEvents();
  }, []);

  useEffect(() => {
    if (!switchModalOpen) return;
    setSwitchError(null);
    loadAccountDetails();
  }, [switchModalOpen]);

  useEffect(() => {
    if (!showAddEventModal) return;
    const base = selectedDate ?? new Date();
    setEventDate(base.toISOString().slice(0, 10));
    setEventTitle("");
    setEventTime("");
    setEventDescription("");
    setEventSaveError(null);
  }, [showAddEventModal, selectedDate]);

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

  function scrollToBottom() {
    setTimeout(() => {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
    }, 50);
  }

  // Fetch full email when a result card is clicked
  useEffect(() => {
    if (!openEmailId) {
      setReaderEmail(null);
      return;
    }
    setReaderLoading(true);
    fetch(`/email/${openEmailId}`)
      .then((r) => r.json())
      .then((d: EmailDetail) => setReaderEmail(d))
      .catch(() => setReaderEmail(null))
      .finally(() => setReaderLoading(false));
  }, [openEmailId]);

  // Close reader with Escape key
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && openEmailId) setOpenEmailId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openEmailId]);

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
      if (filter === "All") {
        return new Set(["All"]);
      }
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      next.delete("All");
      if (next.size === 0) next.add("All");
      return next;
    });
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    setSyncNeedsReauth(false);
    setSyncDone(false);
    try {
      const res = await fetch("/emails/sync", { method: "POST", headers: authHeaders() });
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
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          messages: historyForApi,
          top_k: 5,
          active_email_id: openEmailId ?? undefined,
          filters: {
            has_attachment: activeFilters.has("Has attachment"),
            unread_only: activeFilters.has("Unread"),
            last_30_days: activeFilters.has("Last 30 days"),
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
      const agentMode = data.mode;
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
          mode: agentMode,
          results: count > 0 && agentMode !== "chitchat" ? results : undefined,
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

  async function loadAccountDetails() {
    try {
      const data = await getAccounts();
      setAccountDetails(data.accounts);
      if (data.active) setActiveAccount(data.active);
    } catch {
      // Keep existing UI if load fails.
    }
  }

  async function handleSwitchAccount(email: string) {
    if (email === activeAccount || switchingTo) return;
    setSwitchingTo(email);
    setSwitchError(null);
    try {
      const result = await switchAccount(email);
      setActiveAccount(result.active);
      setGmailEmail(result.active);
      setEmailCount(result.emailCount);
      setAccounts((prev) => {
        const rest = prev.filter((a) => a !== result.active);
        return [result.active, ...rest];
      });
      setAccountDetails((prev) =>
        prev.map((a) => ({
          ...a,
          status: a.email === result.active ? "active" : "cached",
          emailCount: a.email === result.active ? result.emailCount : a.emailCount,
        })),
      );
      setSwitchModalOpen(false);
      clearChat(result.active);
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : "Switch failed.");
    } finally {
      setSwitchingTo(null);
    }
  }

  function clearChat(forEmail?: string) {
    const email = forEmail ?? primaryEmail;
    const name = email ? email.split("@")[0].split(".")[0] : null;
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

  async function handleCreateEvent() {
    if (!eventTitle.trim()) {
      setEventSaveError("Title is required.");
      return;
    }
    if (!eventDate) {
      setEventSaveError("Date is required.");
      return;
    }
    setEventSaving(true);
    setEventSaveError(null);
    try {
      await createEvent({
        title: eventTitle.trim(),
        date: eventDate,
        time: eventTime || undefined,
        description: eventDescription.trim() || undefined,
      });
      setShowAddEventModal(false);
      await loadCalendarEvents();
    } catch (err) {
      setEventSaveError(err instanceof Error ? err.message : "Failed to create event.");
    } finally {
      setEventSaving(false);
    }
  }

  async function handleDeleteEvent(eventId: string) {
    try {
      await deleteEvent(eventId);
      await loadCalendarEvents();
    } catch {
      // Keep UI stable even if delete fails.
    }
  }

  const userInitials = primaryEmail ? initials(primaryEmail) : "?";
  const firstName = primaryEmail ? primaryEmail.split("@")[0].split(".")[0] : "there";
  const accountCount = accounts.length > 0 ? accounts.length : primaryEmail ? 1 : 0;

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
  const sidebarPanelLabel =
    sidebarTab === "search" ? "Search" : sidebarTab === "calendar" ? "Calendar" : "History";
  const accountPillLabel = primaryEmail ?? "No account connected";
  const messageSearchPool = messages.filter((m) => m.role === "user" || m.results?.length);
  const sidebarSearchResults = sidebarSearchQuery.trim()
    ? messageSearchPool.filter((m) =>
        m.content.toLowerCase().includes(sidebarSearchQuery.trim().toLowerCase()),
      )
    : [];
  const parsedCalendarEvents = calendarEvents
    .map((e) => ({ ...e, dateObj: new Date(e.date) }))
    .filter((e) => !isNaN(e.dateObj.getTime()));
  const monthStart = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const calendarStart = new Date(monthStart);
  calendarStart.setDate(calendarStart.getDate() - calendarStart.getDay());
  const calendarCells = Array.from({ length: 42 }, (_, idx) => {
    const d = new Date(calendarStart);
    d.setDate(calendarStart.getDate() + idx);
    return d;
  });
  const visibleEvents = selectedDate
    ? parsedCalendarEvents.filter((e) => isSameDay(e.dateObj, selectedDate))
    : parsedCalendarEvents
        .filter((e) => e.dateObj.getTime() >= new Date(new Date().setHours(0, 0, 0, 0)).getTime())
        .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime())
        .slice(0, 6);

  return (
    <div className="db">
      <nav className="db-nav">
        <button type="button" className="db-logo db-logo-btn" onClick={() => clearChat()}>
          <div className="db-logo-mark">
            <img src={iconUrl} alt="" width={48} height={48} style={{ objectFit: "contain" }} />
          </div>
          <span className="db-logo-wordmark">Mail Sherlock</span>
        </button>
        <button type="button" className="db-account-pill" onClick={() => setSwitchModalOpen(true)}>
          <span className="db-account-pill-dot" />
          <span className="db-account-pill-text">{accountPillLabel}</span>
          <span className="db-account-pill-caret">▾</span>
        </button>
        <div className="db-nav-right">
          <button type="button" className="db-new-conv" onClick={() => clearChat()}>
            New chat
          </button>
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
                <div className="db-avatar-menu-h">Signed in</div>
                <div className="db-avatar-email" title={accountPillLabel}>
                  {accountPillLabel}
                </div>
                <div className="db-avatar-divider" />
                <button
                  type="button"
                  className="db-avatar-item"
                  onClick={() => {
                    setAvatarOpen(false);
                    setSwitchModalOpen(true);
                  }}
                >
                  <span className="db-avatar-item-icon">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="4.3" r="2.2" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M2.4 11.8c.8-2 2.5-3 4.6-3s3.8 1 4.6 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </span>
                  Accounts
                </button>
                <button type="button" className="db-avatar-item" onClick={() => setAvatarOpen(false)}>
                  <span className="db-avatar-item-icon">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M2 11V8.5M5.4 11V6M8.6 11V4M12 11V2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </span>
                  Insights
                </button>
                <button type="button" className="db-avatar-item" onClick={() => setAvatarOpen(false)}>
                  <span className="db-avatar-item-icon">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="7" r="2.1" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M7 1.5v1.5M7 11v1.5M1.5 7H3M11 7h1.5M3 3l1 1M10 10l1 1M3 11l1-1M10 4l1-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  </span>
                  Settings
                </button>
                <a href={authLoginUrl()} className="db-avatar-item" onClick={() => setAvatarOpen(false)}>
                  <span className="db-avatar-item-icon">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </span>
                  Connect Gmail
                </a>
                <button
                  type="button"
                  className="db-avatar-item db-avatar-signout"
                  onClick={async () => {
                    setAvatarOpen(false);
                    const token = localStorage.getItem("mailSherlockAuthToken");
                    if (token) await logoutSession(token).catch(() => {});
                    await fetch("/auth/logout", { method: "POST" }).catch(() => {});
                    localStorage.removeItem("mailSherlockAuthToken");
                    navigate("landing");
                  }}
                >
                  <span className="db-avatar-item-icon">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M5.5 2.2H3.4c-.6 0-1 .4-1 1v7.6c0 .6.4 1 1 1h2.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      <path d="M8 4.5l2.6 2.5L8 9.5M10.4 7H5.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <div className="db-layout">
        <aside className="db-sidebar">
          <div className="db-sidebar-tabrail">
            <div className="db-sidebar-tabrow">
              <button
                type="button"
                className={`db-sidebar-tabbtn${sidebarTab === "search" ? " active" : ""}`}
                onClick={() => setSidebarTab("search")}
                aria-label="Search panel"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="6.3" cy="6.3" r="4.2" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M9.6 9.6L12.4 12.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className={`db-sidebar-tabbtn${sidebarTab === "calendar" ? " active" : ""}`}
                onClick={() => setSidebarTab("calendar")}
                aria-label="Calendar panel"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="1.7" y="2.6" width="10.6" height="9.7" rx="2" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M1.7 5.2h10.6M4.6 1.5v2.2M9.4 1.5v2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className={`db-sidebar-tabbtn${sidebarTab === "history" ? " active" : ""}`}
                onClick={() => setSidebarTab("history")}
                aria-label="History panel"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.4 4h9.2M2.4 7h9.2M2.4 10h6.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              <span className="db-sidebar-tablabel">{sidebarPanelLabel}</span>
            </div>
          </div>
          {sidebarTab === "search" && (
            <div className="db-sidebar-panel">
              <input
                className="db-side-search"
                value={sidebarSearchQuery}
                onChange={(e) => setSidebarSearchQuery(e.target.value)}
                placeholder="Search emails & chats..."
              />
              {sidebarSearchQuery.trim() ? (
                <div className="db-side-list">
                  {sidebarSearchResults.length === 0 && <div className="db-side-empty">No matches yet</div>}
                  {sidebarSearchResults.slice(0, 8).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="db-side-item"
                      onClick={() =>
                        chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" })
                      }
                    >
                      <div className="db-side-item-title">{m.content.slice(0, 56)}</div>
                      <div className="db-side-item-meta">
                        {m.role === "user" ? "Conversation" : "Email results"} · {m.time}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="db-side-empty-hero">Search your emails & chats</div>
              )}
            </div>
          )}
          {sidebarTab === "calendar" && (
            <div className="db-sidebar-panel">
              <div className="db-side-cal-head">
                <button
                  type="button"
                  onClick={() =>
                    setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))
                  }
                >
                  ←
                </button>
                <span>{calendarMonth.toLocaleDateString([], { month: "long", year: "numeric" })}</span>
                <button
                  type="button"
                  onClick={() =>
                    setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))
                  }
                >
                  →
                </button>
              </div>
              <div className="db-side-cal-grid">
                {WEEKDAY_LABELS.map((d) => (
                  <div key={d} className="db-side-cal-dow">
                    {d}
                  </div>
                ))}
                {calendarCells.map((d) => {
                  const inMonth = d.getMonth() === calendarMonth.getMonth();
                  const hasEvent = parsedCalendarEvents.some((e) => isSameDay(e.dateObj, d));
                  const isSelected = selectedDate ? isSameDay(selectedDate, d) : false;
                  const isToday = isSameDay(new Date(), d);
                  return (
                    <button
                      key={d.toISOString()}
                      type="button"
                      className={`db-side-cal-day${inMonth ? "" : " out"}${isSelected ? " sel" : ""}${isToday ? " today" : ""}`}
                      onClick={() => setSelectedDate(isSelected ? null : d)}
                    >
                      <span>{d.getDate()}</span>
                      {hasEvent && <em />}
                    </button>
                  );
                })}
              </div>
              <div className="db-side-events">
                {calendarLoading && <div className="db-side-empty">Loading events...</div>}
                {calendarError && <div className="db-side-empty">{calendarError}</div>}
                {visibleEvents.length === 0 && <div className="db-side-empty">No events</div>}
                {visibleEvents.map((e) => (
                  <div key={e.id} className="db-side-event-wrap">
                    <button
                      type="button"
                      className="db-side-event"
                      onClick={() => {
                        if (e.source_email_id) setOpenEmailId(e.source_email_id);
                      }}
                    >
                    <span className="db-side-event-bar" style={{ background: eventColor(e.source) }} />
                    <span className="db-side-event-main">
                      <strong>{e.title}</strong>
                      <small>
                        {e.dateObj.toLocaleDateString([], { month: "short", day: "numeric" })}
                        {e.time ? ` · ${e.time}` : ""}
                        {e.source === "from_email" ? " · from email" : " · manual"}
                      </small>
                    </span>
                    </button>
                    {e.source === "manual" && (
                      <button
                        type="button"
                        className="db-side-event-del"
                        onClick={() => handleDeleteEvent(e.id)}
                        aria-label="Delete event"
                        title="Delete event"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button type="button" className="db-side-add-event" onClick={() => setShowAddEventModal(true)}>
                + Add event
              </button>
            </div>
          )}
          {sidebarTab === "history" && (
            <div className="db-sidebar-panel">
              <div className="db-side-history-group">Recent</div>
              {messages
                .slice(-8)
                .reverse()
                .map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="db-side-item"
                    onClick={() =>
                      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" })
                    }
                  >
                    <div className="db-side-item-title">{m.content.slice(0, 52)}</div>
                    <div className="db-side-item-meta">{m.time}</div>
                  </button>
                ))}
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
            </div>
            <div className="db-chips">
              {FILTER_CHIPS.map((chip) => (
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
                        const smartLabels = r.smartLabels ?? [];
                        const isOpen = openEmailId === r.id;
                        return (
                          <div
                            key={r.id}
                            className={`db-rc${isOpen ? " db-rc-open" : ""}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => setOpenEmailId(isOpen ? null : r.id)}
                            onKeyDown={(e) => e.key === "Enter" && setOpenEmailId(isOpen ? null : r.id)}
                          >
                            <div className="db-rc-top">
                              <span className="db-rc-from">{r.from}</span>
                              <span className="db-rc-date">{formatEmailDate(r.date)}</span>
                            </div>
                            <div className="db-rc-subj">{r.subject}</div>
                            <div className="db-rc-snip">{r.snippet}</div>
                            <div className="db-rc-foot">
                              {smartLabels.map((label) => (
                                <span key={label} className={`db-rc-tag db-label-${label}`}>
                                  {label}
                                </span>
                              ))}
                              {r.hasAttachment && (
                                <span className="db-rc-attach">📎</span>
                              )}
                              {score > 0 && <span className="db-rc-score">{score}% match</span>}
                              <span className="db-rc-open-hint">{isOpen ? "Reading ↑" : "Read →"}</span>
                            </div>
                          </div>
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
              <input
                type="text"
                placeholder={
                  canSearch
                    ? "Ask me anything about your emails..."
                    : "Connect Gmail to search your mail..."
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
            <div className="db-input-hint">results ranked by semantic similarity</div>
          </div>
        </main>

        {/* ── Email Reader Panel ── */}
        <aside className="db-reader" style={openEmailId ? { width: "360px" } : undefined}>
          <div className="db-reader-topbar">
            <button
              type="button"
              className="db-reader-close"
              onClick={() => setOpenEmailId(null)}
              aria-label="Close email reader"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <line x1="1" y1="1" x2="13" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <line x1="13" y1="1" x2="1" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <span className="db-reader-title">Reading email</span>
          </div>

          {readerLoading ? (
            <div className="db-reader-loading">
              <div className="db-reader-spinner" />
            </div>
          ) : readerEmail ? (
            <>
              <div className="db-reader-header">
                <div className="db-reader-subject">{readerEmail.subject}</div>
                <div className="db-reader-meta">
                  <span className="db-reader-from">{readerEmail.sender}</span>
                  <span className="db-reader-date">{formatEmailDate(readerEmail.date)}</span>
                </div>
                {readerEmail.smartLabels.length > 0 && (
                  <div className="db-reader-labels">
                    {readerEmail.smartLabels.map((l) => (
                      <span key={l} className={`db-rc-tag db-label-${l}`}>{l}</span>
                    ))}
                    {readerEmail.isUnread && (
                      <span className="db-rc-tag db-label-unread">unread</span>
                    )}
                  </div>
                )}
                {readerEmail.attachments.length > 0 && (
                  <div className="db-reader-attachments">
                    {readerEmail.attachments.map((a) => (
                      <div key={a.filename} className="db-reader-attach">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                          <rect x="1.5" y="0.5" width="9" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
                          <line x1="3.5" y1="4" x2="8.5" y2="4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                          <line x1="3.5" y1="6.5" x2="8.5" y2="6.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                          <line x1="3.5" y1="9" x2="6.5" y2="9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                        </svg>
                        <span className="db-reader-attach-name">{a.filename}</span>
                        <span className="db-reader-attach-size">{formatBytes(a.size)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="db-reader-body">
                {readerEmail.bodyHtml ? (
                  <div
                    className="db-reader-html"
                    dangerouslySetInnerHTML={{ __html: readerEmail.bodyHtml }}
                  />
                ) : (
                  <pre className="db-reader-text">{readerEmail.bodyText || readerEmail.snippet}</pre>
                )}
              </div>
            </>
          ) : openEmailId ? (
            <div className="db-reader-empty">Could not load email.</div>
          ) : null}
        </aside>
      </div>

      {showAddEventModal && (
        <div className="db-event-modal-overlay" onClick={() => setShowAddEventModal(false)}>
          <div className="db-event-modal" onClick={(e) => e.stopPropagation()}>
            <div className="db-event-modal-head">
              <h3>Add Event</h3>
              <button type="button" className="db-event-modal-close" onClick={() => setShowAddEventModal(false)}>
                ×
              </button>
            </div>
            <label className="db-event-field">
              <span>Title</span>
              <input value={eventTitle} onChange={(e) => setEventTitle(e.target.value)} placeholder="Event title" />
            </label>
            <div className="db-event-row">
              <label className="db-event-field">
                <span>Date</span>
                <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
              </label>
              <label className="db-event-field">
                <span>Time</span>
                <input type="time" value={eventTime} onChange={(e) => setEventTime(e.target.value)} />
              </label>
            </div>
            <label className="db-event-field">
              <span>Description</span>
              <textarea
                rows={2}
                value={eventDescription}
                onChange={(e) => setEventDescription(e.target.value)}
                placeholder="Optional details"
              />
            </label>
            {eventSaveError && <div className="db-event-error">{eventSaveError}</div>}
            <div className="db-event-actions">
              <button type="button" className="db-event-cancel" onClick={() => setShowAddEventModal(false)}>
                Cancel
              </button>
              <button type="button" className="db-event-submit" onClick={handleCreateEvent} disabled={eventSaving}>
                {eventSaving ? "Saving..." : "Add event"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Switch Account Modal ── */}
      {switchModalOpen && (
        <div className="db-modal-overlay" onClick={() => setSwitchModalOpen(false)}>
          <div className="db-modal" onClick={(e) => e.stopPropagation()}>
            <div className="db-modal-header">
              <span className="db-modal-title">Switch Account</span>
              <button type="button" className="db-modal-close" onClick={() => setSwitchModalOpen(false)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                  <line x1="1" y1="1" x2="13" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <line x1="13" y1="1" x2="1" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="db-modal-body">
              {(accountDetails.length > 0 ? accountDetails : accounts.map((a) => ({ email: a, status: a === activeAccount ? "active" : "cached", emailCount: a === activeAccount ? emailCount : 0, lastSynced: null } as Account))).map((acc) => {
                const isActive = acc.email === activeAccount;
                const dotColor = acc.status === "active" ? "#34A853" : acc.status === "needs_login" ? "#A32D2D" : acc.status === "failed" ? "#A32D2D" : "#888888";
                const lastSyncLabel = acc.lastSynced
                  ? formatRelativeTime(new Date(acc.lastSynced * 1000))
                  : null;
                return (
                  <div key={acc.email} className={`db-modal-account${isActive ? " active" : ""}`}>
                    <div className="db-modal-acc-row">
                      <div className="db-acc-dot" style={{ background: dotColor }} />
                      <div className="db-modal-acc-info">
                        <div className="db-modal-acc-email">{acc.email}</div>
                        <div className="db-modal-acc-meta">
                          {acc.emailCount > 0 ? `${acc.emailCount.toLocaleString()} emails` : "No emails indexed"}
                          {lastSyncLabel ? ` · Synced ${lastSyncLabel}` : ""}
                        </div>
                      </div>
                      {isActive && <span className="db-modal-badge">active</span>}
                    </div>
                    {isActive ? (
                      <button
                        type="button"
                        className="db-modal-sync-btn"
                        onClick={() => { setSwitchModalOpen(false); handleSync(); }}
                        disabled={syncing}
                      >
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                          <path d="M10 6A4 4 0 1 1 6 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          <path d="M6 2l2-2M6 2l2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {syncing ? "Syncing…" : "Sync now"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="db-modal-switch-to-btn"
                        onClick={() => handleSwitchAccount(acc.email)}
                        disabled={switchingTo === acc.email}
                      >
                        {switchingTo === acc.email ? "Switching…" : "Switch to this account"}
                      </button>
                    )}
                  </div>
                );
              })}
              {switchError && <div className="db-modal-error">{switchError}</div>}
              <div className="db-modal-divider" />
              <a href={authLoginUrl()} className="db-modal-add-acc" onClick={() => setSwitchModalOpen(false)}>
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                  <line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                Connect a new Gmail account
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
