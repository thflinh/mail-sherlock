import { useState, useEffect, useRef } from "react";
import "./Dashboard.css";
import type { Page } from "../App";
import iconUrl from "../assets/icon.png";
import type { AgentMode, EmailDetail, EmailResult } from "../types";
import { createEvent, deleteEvent, getEvents, type CalendarEvent } from "../api/events";
import { logoutSession } from "../api/auth";
import { authHeaders } from "../api/http";

interface Props {
  navigate: (to: Page) => void;
}

type Suggestion = { label: string; query: string };
type SidebarTab = "history" | "calendar";

type Message = {
  id: number;
  role: "user" | "ai";
  content: string;
  results?: EmailResult[];
  suggestions?: Suggestion[];
  mode?: AgentMode;
  activeEmailId?: string;
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

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toLocalDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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
// openEmailId: email currently open in the in-app reader panel
  const [openEmailId, setOpenEmailId] = useState<string | null>(null);
  const [readerEmail, setReaderEmail] = useState<EmailDetail | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const msgIdRef = useRef(0);
  const historyLoadedRef = useRef(false);

  const [gmailEmail, setGmailEmail] = useState<string | null>(null);
  const [emailCount, setEmailCount] = useState(0);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncNeedsReauth, setSyncNeedsReauth] = useState(false);
  const [syncDone, setSyncDone] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<{ id: string; title: string; updated_at: string }[]>([]);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("history");
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
  const [showOnboard, setShowOnboard] = useState(() => localStorage.getItem("mailSherlockHideOnboard") !== "1");
  const [onboardStep, setOnboardStep] = useState(0);
  const [onboardDontShow, setOnboardDontShow] = useState(false);

  function closeOnboard() {
    if (onboardDontShow) localStorage.setItem("mailSherlockHideOnboard", "1");
    setShowOnboard(false);
  }

  function applyStatusPayload(d: {
    accounts?: string[];
    gmailAuthEmail?: string | null;
    emailCount?: number;
  }) {
    const primary = d.gmailAuthEmail ?? (Array.isArray(d.accounts) ? d.accounts[0] : null) ?? null;
    setGmailEmail(primary);
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
    if (!showAddEventModal) return;
    const base = selectedDate ?? new Date();
    setEventDate(toLocalDateStr(base));
    setEventTitle("");
    setEventTime("");
    setEventDescription("");
    setEventSaveError(null);
  }, [showAddEventModal, selectedDate]);

  const primaryEmail = gmailEmail;

  useEffect(() => {
    if (!statusLoaded || historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    const name = primaryEmail ? primaryEmail.split("@")[0].split(".")[0] : null;
    const greeting: Message = {
      id: ++msgIdRef.current,
      role: "ai",
      content: name
        ? `Hi ${name}! I'm your Sherlock assistant. Describe any email you're looking for and I'll find it across your connected accounts.`
        : "Connect your Gmail account to start searching your emails by meaning — not just keywords.",
      suggestions: undefined,
      time: nowTime(),
    };
    fetch("/chat/history", { headers: authHeaders() })
      .then((r) => r.json())
      .then((d: { conv_id?: string | null; messages?: { role: string; content: string; time: string; results?: EmailResult[]; mode?: AgentMode }[]; conversations?: { id: string; title: string; updated_at: string }[] }) => {
        const saved = d.messages ?? [];
        setActiveConvId(d.conv_id ?? null);
        setConversationList(d.conversations ?? []);
        if (saved.length === 0) {
          setMessages([greeting]);
        } else {
          setMessages(
            saved.map((m) => ({
              id: ++msgIdRef.current,
              role: m.role === "user" ? ("user" as const) : ("ai" as const),
              content: m.content,
              time: m.time ?? "",
              results: m.results,
              mode: m.mode,
            })),
          );
        }
      })
      .catch(() => setMessages([greeting]));
  }, [statusLoaded, primaryEmail]);

  function scrollToBottom() {
    setTimeout(() => {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
    }, 50);
  }

  function openEmailWithContext(email: EmailResult) {
    setOpenEmailId(email.id);
    const firstName = email.from.split("@")[0].split(/[\s.]/)[0];
    setMessages((prev) => [
      ...prev,
      {
        id: ++msgIdRef.current,
        role: "ai",
        content: `Now reading **${email.subject}** from ${firstName}. What would you like to know?`,
        suggestions: [
          { label: "Summarize this email", query: "Summarize this email" },
          { label: "Action items?", query: "What are the action items in this email?" },
          { label: "Key dates or deadlines?", query: "What are the key dates or deadlines?" },
          { label: "Find similar emails", query: `Find more emails about ${email.subject}` },
        ],
        time: nowTime(),
      },
    ]);
    scrollToBottom();
  }

  // Fetch full email when a result card is clicked
  useEffect(() => {
    if (!openEmailId) {
      setReaderEmail(null);
      return;
    }
    setReaderLoading(true);
    fetch(`/email/${openEmailId}`, { headers: authHeaders() })
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
    if (!msg) { inputRef.current?.focus(); return; }
    if (typing) return;
    const currentEmailId = openEmailId;
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

    const aiMsgId = ++msgIdRef.current;
    setMessages((prev) => [
      ...prev,
      { id: aiMsgId, role: "ai", content: "", time: nowTime() },
    ]);

    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          messages: historyForApi,
          top_k: 5,
          active_email_id: openEmailId ?? undefined,
        }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let metaMode: AgentMode | undefined;
      let metaResults: EmailResult[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(line.slice(6)); } catch { continue; }

          if (payload.type === "thinking") {
            setMessages((prev) =>
              prev.map((m) => (m.id === aiMsgId ? { ...m, content: "..." } : m)),
            );
          } else if (payload.type === "meta") {
            const rawResults = (payload.results as unknown[]) ?? [];
            metaResults = rawResults.map((r) => {
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
            metaMode = payload.mode as AgentMode;
            if (payload.gmailAuthEmail) {
              setGmailEmail(payload.gmailAuthEmail as string);
            } else if (Array.isArray(payload.accounts) && (payload.accounts as string[])[0]) {
              setGmailEmail((payload.accounts as string[])[0]);
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiMsgId
                  ? { ...m, mode: metaMode, results: metaResults.length > 0 && metaMode !== "chitchat" ? metaResults : undefined }
                  : m,
              ),
            );
          } else if (payload.type === "token") {
            const chunk = payload.text as string;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiMsgId
                  ? { ...m, content: (m.content === "..." ? "" : m.content) + chunk }
                  : m,
              ),
            );
            scrollToBottom();
          } else if (payload.type === "done") {
            const count = metaResults.length;
            let suggestions: Suggestion[];
            if (metaMode === "find" && count > 0) {
              const topSubject = metaResults[0]?.subject ?? "";
              const topSender = metaResults[0]?.from ?? "";
              const senderName = topSender.split("@")[0].split(/[\s.]/)[0];
              suggestions = [
                {
                  label: "More about this email",
                  query: topSubject
                    ? `Tell me more about the email from ${senderName} about "${topSubject}"`
                    : `Tell me more about the top email`,
                },
                {
                  label: "Find similar emails",
                  query: topSubject
                    ? `Find more emails like "${topSubject}"`
                    : `Find more emails from ${senderName || "this sender"}`,
                },
                { label: "New search", query: "" },
              ];
            } else if (metaMode === "answer" || metaMode === "summarize" || metaMode === "extract") {
              const topSubject = metaResults[0]?.subject ?? "";
              const topSender = metaResults[0]?.from ?? "";
              const senderName = topSender.split("@")[0].split(/[\s.]/)[0];
              suggestions = [
                { label: "More about this email", query: "What else is important in this email?" },
                {
                  label: "Find similar emails",
                  query: topSubject
                    ? `Find more emails like this one about "${topSubject}"`
                    : `Find more emails from ${senderName || "this sender"}`,
                },
                { label: "New search", query: "" },
              ];
            } else if (count === 0) {
              suggestions = [
                { label: "Try: invoice or receipt", query: "invoice or receipt from last month" },
                { label: "Search by sender", query: `emails from "${msg}"` },
                { label: "New search", query: "" },
              ];
            } else {
              suggestions = [
                { label: "Filter attachments", query: "Show only emails with attachments" },
                { label: "Narrow by date", query: "Emails from the last month" },
                { label: "New search", query: "" },
              ];
            }
            setMessages((prev) => {
              const next = prev.map((m) => (m.id === aiMsgId ? { ...m, suggestions, activeEmailId: currentEmailId ?? undefined } : m));
              // Persist conversation after each completed exchange
              const savedConvId = activeConvId;
              fetch("/chat/history", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders() },
                body: JSON.stringify({
                  conv_id: savedConvId,
                  messages: next.map((m) => ({ role: m.role, content: m.content, time: m.time, results: m.results, mode: m.mode })),
                }),
              }).then((r) => r.json()).then((res: { ok?: boolean; conv_id?: string }) => {
                if (res.ok) {
                  const returnedId = res.conv_id ?? savedConvId;
                  if (returnedId && !savedConvId) setActiveConvId(returnedId);
                  const firstUser = next.find((m) => m.role === "user");
                  const title = firstUser ? firstUser.content.slice(0, 60) : "";
                  setConversationList((prev) => {
                    const idToUse = returnedId ?? savedConvId;
                    if (!idToUse) return prev;
                    const exists = prev.find((c) => c.id === idToUse);
                    if (exists) {
                      return prev.map((c) => c.id === idToUse ? { ...c, title: title || c.title, updated_at: new Date().toISOString() } : c);
                    }
                    return [{ id: idToUse, title, updated_at: new Date().toISOString() }, ...prev];
                  });
                }
              }).catch(() => {});
              return next;
            });
          }
        }
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? { ...m, content: err instanceof Error ? err.message : "Something went wrong. Please try again." }
            : m,
        ),
      );
    } finally {
      setTyping(false);
      scrollToBottom();
    }
  }

  function clearChat(forEmail?: string) {
    const email = forEmail ?? primaryEmail;
    const name = email ? email.split("@")[0].split(".")[0] : null;
    fetch("/chat/history/new", { method: "POST", headers: authHeaders() })
      .then((r) => r.json())
      .then((res: { conv_id?: string }) => {
        if (res.conv_id) {
          setActiveConvId(res.conv_id);
          setConversationList((prev) => [{ id: res.conv_id!, title: "", updated_at: new Date().toISOString() }, ...prev]);
        }
      })
      .catch(() => {});
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

  async function handleDeleteConversation(convId: string) {
    try {
      await fetch(`/chat/history/${convId}`, { method: "DELETE", headers: authHeaders() });
    } catch { /* keep UI stable */ }
    setConversationList((prev) => prev.filter((c) => c.id !== convId));
    if (activeConvId === convId) clearChat();
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
  const openEmailResult = openEmailId
    ? messages.flatMap((m) => m.results ?? []).find((r) => r.id === openEmailId) ?? null
    : null;
  const topbarLine = (() => {
    if (!primaryEmail) return "Connect Gmail to get started";
    if (emailCount === 0 && !syncDone)
      return `${primaryEmail} · Sync your inbox to index emails`;
    const parts = [`${emailCount.toLocaleString()} emails indexed`];
    if (lastSyncedAt) parts.push(`Last synced ${formatRelativeTime(lastSyncedAt)}`);
    else if (syncDone) parts.push("Last synced just now");
    return parts.join(" · ");
  })();

  function formatContent(text: string) {
    return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  const canSearch = statusLoaded && !!primaryEmail;
  const sendDisabled = !query.trim() || typing || !canSearch;
  const sidebarPanelLabel = sidebarTab === "calendar" ? "Calendar" : "History";
  const accountPillLabel = primaryEmail ?? "No account connected";
  const parsedCalendarEvents = calendarEvents
    .map((e) => ({ ...e, dateObj: parseLocalDate(e.date) }))
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
        <div className="db-account-pill">
          <span className="db-account-pill-dot" />
          <span className="db-account-pill-text">{accountPillLabel}</span>
        </div>
        <div className="db-nav-right">
          <button
            type="button"
            className="db-hamburger"
            onClick={() => setMobileDrawerOpen((o) => !o)}
            aria-label="Open panel"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>
          {primaryEmail && (
            <button
              type="button"
              className={`db-sync-nav-btn${syncing ? " is-syncing" : syncDone ? " is-done" : syncError ? " is-err" : ""}`}
              onClick={handleSync}
              disabled={syncing}
              title={syncError ? `Sync failed: ${syncError}` : syncDone ? "Synced — click to re-sync" : "Sync inbox"}
            >
              {syncing ? (
                <>
                  <span className="db-sync-nav-spin" />
                  <span className="db-sync-nav-label">Syncing…</span>
                </>
              ) : syncDone ? (
                <>
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
                    <path d="M1.5 5.5l3 3 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span className="db-sync-nav-label">Synced</span>
                </>
              ) : syncError ? (
                <>
                  <span className="db-sync-nav-err">!</span>
                  <span className="db-sync-nav-label">Sync</span>
                </>
              ) : (
                <>
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
                    <path d="M9.5 5.5A4 4 0 1 1 7 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    <path d="M7 1v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span className="db-sync-nav-label">Sync</span>
                </>
              )}
            </button>
          )}
          <button type="button" className="db-new-conv" onClick={() => clearChat()}>
            New chat
          </button>
          <button
            type="button"
            className="db-help-btn"
            onClick={() => { setOnboardStep(0); setShowOnboard(true); }}
            title="How to use Mail Sherlock"
            aria-label="Help"
          >
            ?
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
        {mobileDrawerOpen && <div className="db-sidebar-backdrop" onClick={() => setMobileDrawerOpen(false)} />}
        <aside className={`db-sidebar${mobileDrawerOpen ? " db-sidebar--open" : ""}`}>
          <div className="db-sidebar-tabrail">
            <div className="db-sidebar-tabrow">
              <button
                type="button"
                className={`db-sidebar-tabbtn${sidebarTab === "history" ? " active" : ""}`}
                onClick={() => setSidebarTab("history")}
                aria-label="History panel"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M7 4.5V7l2 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
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
              <span className="db-sidebar-tablabel">{sidebarPanelLabel}</span>
            </div>
          </div>
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
              {conversationList.length === 0 && <div className="db-side-empty">No conversations yet</div>}
              {conversationList.map((conv) => {
                const isActive = conv.id === activeConvId;
                const label = conv.title || "New conversation";
                return (
                  <div key={conv.id} className="db-side-conv-wrap">
                    <button
                      type="button"
                      className={`db-side-item${isActive ? " active" : ""}`}
                      onClick={() => {
                        if (isActive) {
                          chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
                          return;
                        }
                        fetch(`/chat/history/${conv.id}`, { headers: authHeaders() })
                          .then((r) => r.json())
                          .then((d: { messages?: { role: string; content: string; time: string; results?: EmailResult[]; mode?: AgentMode }[] }) => {
                            const saved = d.messages ?? [];
                            setActiveConvId(conv.id);
                            setMessages(saved.map((m) => ({
                              id: ++msgIdRef.current,
                              role: m.role === "user" ? ("user" as const) : ("ai" as const),
                              content: m.content,
                              time: m.time ?? "",
                              results: m.results,
                              mode: m.mode,
                            })));
                            setTimeout(() => chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" }), 50);
                            setMobileDrawerOpen(false);
                          })
                          .catch(() => {});
                      }}
                    >
                      <div className="db-side-item-title">{label.slice(0, 52)}</div>
                      <div className="db-side-item-meta">{conv.updated_at ? new Date(conv.updated_at).toLocaleDateString() : ""}</div>
                    </button>
                    <button
                      type="button"
                      className="db-side-conv-del"
                      onClick={(e) => { e.stopPropagation(); handleDeleteConversation(conv.id); }}
                      aria-label="Delete conversation"
                      title="Delete conversation"
                    >
                      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
                        <path d="M1.5 3h8M4 3V2h3v1M4.5 5v3.5M6.5 5v3.5M2.5 3l.5 6h5l.5-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </div>
                );
              })}
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

                  {(() => {
                    if (!msg.results || msg.results.length === 0) return null;
                    if (msg.mode === "answer" || msg.mode === "extract") return null;
                    const resultsToShow = msg.mode === "summarize"
                      ? msg.results.filter((r) => r.id === msg.activeEmailId).slice(0, 1)
                      : msg.results;
                    if (resultsToShow.length === 0) return null;
                    return (
                    <div className="db-rc-list">
                      {resultsToShow.map((r) => {
                        const score = r.score ?? 0;
                        const smartLabels = r.smartLabels ?? [];
                        const isOpen = openEmailId === r.id;
                        return (
                          <div
                            key={r.id}
                            className={`db-rc${isOpen ? " db-rc-open" : ""}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => isOpen ? setOpenEmailId(null) : openEmailWithContext(r)}
                            onKeyDown={(e) => e.key === "Enter" && (isOpen ? setOpenEmailId(null) : openEmailWithContext(r))}
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
                    );
                  })()}

                  {msg.suggestions && (
                    <div className="db-suggestions">
                      {msg.suggestions.map((s) => (
                        <span
                          key={s.label}
                          className="db-sug"
                          onClick={() => {
                            if (!s.query) {
                              setOpenEmailId(null);
                              setQuery("");
                              setTimeout(() => inputRef.current?.focus(), 0);
                            } else {
                              sendMessage(s.query);
                            }
                          }}
                        >
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
            {openEmailResult && (
              <div className="db-reading-banner">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                  <rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.4"/>
                  <line x1="3" y1="4" x2="9" y2="4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  <line x1="3" y1="6.5" x2="9" y2="6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  <line x1="3" y1="9" x2="6" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                <span>Asking about: <strong>{openEmailResult.subject}</strong></span>
                <button type="button" className="db-reading-banner-close" onClick={() => setOpenEmailId(null)} aria-label="Stop reading this email">×</button>
              </div>
            )}
            <div className="db-input-wrap">
              <input
                ref={inputRef}
                type="text"
                placeholder={
                  openEmailResult
                    ? `Ask about "${openEmailResult.subject.slice(0, 40)}…"`
                    : canSearch
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
                  <iframe
                    className="db-reader-iframe"
                    srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:12px;font-family:system-ui,sans-serif;font-size:13px;line-height:1.6;color:#111;word-break:break-word;}img{max-width:100%;height:auto;}a{color:#4f46e5;}table{border-collapse:collapse;width:100%;font-size:12px;}td,th{border:0.5px solid #ddd;padding:4px 8px;}blockquote{border-left:3px solid #ccc;margin:8px 0;padding:4px 12px;color:#555;}</style></head><body>${readerEmail.bodyHtml}</body></html>`}
                    sandbox="allow-same-origin allow-popups"
                    title="Email content"
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

      {showOnboard && (
        <div className="db-onboard-overlay" onClick={closeOnboard}>
          <div className="db-onboard-popup" onClick={(e) => e.stopPropagation()}>
            <div className="db-onboard-popup-header">
              <span className="db-onboard-popup-title">Getting started</span>
              <button type="button" className="db-onboard-popup-close" onClick={closeOnboard} aria-label="Close">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                  <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </button>
            </div>

            <div className="db-onboard-popup-body">
              {onboardStep === 0 && (
                <div className="db-onboard-slide">
                  <div className="db-onboard-slide-icon">
                    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                      <circle cx="14" cy="14" r="13" stroke="var(--primary)" strokeWidth="1.5" strokeDasharray="3 3"/>
                      <path d="M19 14A5 5 0 1 1 16 9.27" stroke="var(--primary)" strokeWidth="1.6" strokeLinecap="round"/>
                      <path d="M16 8v4h4" stroke="var(--primary)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <h3 className="db-onboard-slide-title">Sync your inbox first</h3>
                  <p className="db-onboard-slide-desc">
                    Click <strong>Sync</strong> in the top bar to import your Gmail emails. Mail Sherlock indexes them so you can search by meaning.
                  </p>
                  <div className="db-onboard-slide-status">
                    {syncing && (
                      <span className="db-onboard-status-row is-syncing">
                        <span className="db-onboard-spin" /> Syncing your emails…
                      </span>
                    )}
                    {!syncing && (emailCount > 0 || syncDone) && (
                      <span className="db-onboard-status-row is-done">
                        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
                          <path d="M2 6.5l3.5 3.5 5.5-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        {emailCount.toLocaleString()} emails indexed
                      </span>
                    )}
                    {!syncing && syncError && (
                      <span className="db-onboard-status-row is-err">
                        Sync failed — {syncError}
                        <button className="db-onboard-retry" onClick={handleSync}>Retry</button>
                      </span>
                    )}
                    {!syncing && syncNeedsReauth && (
                      <span className="db-onboard-status-row is-err">
                        Session expired — sign out and sign in again.
                      </span>
                    )}
                    {!syncing && emailCount === 0 && !syncDone && !syncError && !syncNeedsReauth && (
                      <button className="db-onboard-sync-cta" onClick={() => { handleSync(); }} disabled={!primaryEmail}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                          <path d="M10 6A4 4 0 1 1 7.5 2.27" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                          <path d="M7.5 1.5v3h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        Sync inbox now
                      </button>
                    )}
                  </div>
                </div>
              )}

              {onboardStep === 1 && (
                <div className="db-onboard-slide">
                  <div className="db-onboard-slide-icon">
                    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                      <circle cx="14" cy="14" r="13" stroke="var(--primary)" strokeWidth="1.5" strokeDasharray="3 3"/>
                      <circle cx="12" cy="12.5" r="4.5" stroke="var(--primary)" strokeWidth="1.6"/>
                      <path d="M15.5 16l3.5 3.5" stroke="var(--primary)" strokeWidth="1.6" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <h3 className="db-onboard-slide-title">Ask Sherlock anything</h3>
                  <p className="db-onboard-slide-desc">
                    Type a natural-language question in the chat. Sherlock finds emails by meaning, not just keywords.
                  </p>
                  <div className="db-onboard-slide-examples">
                    <span className="db-onboard-example">"emails about invoices from last month"</span>
                    <span className="db-onboard-example">"messages from my manager about the project"</span>
                    <span className="db-onboard-example">"any receipts from Amazon"</span>
                  </div>
                </div>
              )}

              {onboardStep === 2 && (
                <div className="db-onboard-slide">
                  <div className="db-onboard-slide-icon">
                    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                      <circle cx="14" cy="14" r="13" stroke="var(--primary)" strokeWidth="1.5" strokeDasharray="3 3"/>
                      <circle cx="14" cy="11" r="3" stroke="var(--primary)" strokeWidth="1.6"/>
                      <path d="M8 21c0-3.31 2.69-6 6-6s6 2.69 6 6" stroke="var(--primary)" strokeWidth="1.6" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <h3 className="db-onboard-slide-title">Sign out</h3>
                  <p className="db-onboard-slide-desc">
                    Click your avatar in the <strong>top-right corner</strong> to open the account menu, then choose <strong>Sign out</strong>.
                  </p>
                  <div className="db-onboard-signout-hint">
                    <div className="db-onboard-hint-avatar">{userInitials}</div>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                      <path d="M5 7h7M9 4.5L11.5 7 9 9.5" stroke="var(--muted2)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span className="db-onboard-hint-label">Sign out</span>
                  </div>
                </div>
              )}

              <label className="db-onboard-dont-show">
                <input
                  type="checkbox"
                  checked={onboardDontShow}
                  onChange={(e) => setOnboardDontShow(e.target.checked)}
                />
                Don't show this again
              </label>
            </div>

            <div className="db-onboard-popup-footer">
              <div className="db-onboard-dots">
                {[0, 1, 2].map((i) => (
                  <button
                    key={i}
                    type="button"
                    className={`db-onboard-dot${onboardStep === i ? " active" : ""}`}
                    onClick={() => setOnboardStep(i)}
                    aria-label={`Step ${i + 1}`}
                  />
                ))}
              </div>
              <div className="db-onboard-nav-btns">
                {onboardStep > 0 && (
                  <button type="button" className="db-onboard-nav-btn" onClick={() => setOnboardStep((s) => s - 1)} aria-label="Previous">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                      <path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                )}
                {onboardStep < 2 ? (
                  <button type="button" className="db-onboard-nav-btn primary" onClick={() => setOnboardStep((s) => s + 1)} aria-label="Next">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                      <path d="M5.5 3L9.5 7l-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                ) : (
                  <button type="button" className="db-onboard-nav-btn primary done" onClick={closeOnboard}>
                    Done
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

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

    </div>
  );
}
