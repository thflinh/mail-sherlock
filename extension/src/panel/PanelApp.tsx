import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { chatSearch, ChatApiMessage } from "../api/search";
import {
  PANEL_ENABLED_STORAGE_KEY,
  TAG_SHELL_TOP_STORAGE_KEY,
} from "../constants";
import ResultCard from "../components/ResultCard";
import type { ChatTurn } from "../types/chat";

const symbolUrl = chrome.runtime.getURL("icons/symbol.png");

const TAG_HEADER_MIN_PX = 56;
const TAG_FOOTER_MARGIN_PX = 12;
const DRAG_THRESHOLD_PX = 5;

function clampShellTop(top: number, shellHeight: number): number {
  const minY = TAG_HEADER_MIN_PX;
  const maxY = window.innerHeight - shellHeight - TAG_FOOTER_MARGIN_PX;
  if (maxY < minY) return minY;
  return Math.max(minY, Math.min(maxY, top));
}

export default function PanelApp() {
  const [panelEnabled, setPanelEnabled] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [gmailAuthEmail, setGmailAuthEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [shellTopPx, setShellTopPx] = useState(80);

  const shellRef = useRef<HTMLDivElement>(null);
  const shellTopRef = useRef(80);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { shellTopRef.current = shellTopPx; }, [shellTopPx]);

  /* Restore saved vertical position */
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const h = shellRef.current?.offsetHeight ?? 80;
        void chrome.storage.local.get(TAG_SHELL_TOP_STORAGE_KEY).then((r) => {
          const raw = r[TAG_SHELL_TOP_STORAGE_KEY];
          if (typeof raw === "number" && !Number.isNaN(raw)) {
            setShellTopPx(clampShellTop(raw, h));
          } else {
            setShellTopPx(clampShellTop((window.innerHeight - h) / 2, h));
          }
        });
      });
    });
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const onResize = () => {
      const h = shellRef.current?.offsetHeight ?? 80;
      setShellTopPx((t) => clampShellTop(t, h));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const h = shellRef.current?.offsetHeight ?? 80;
    setShellTopPx((t) => clampShellTop(t, h));
  }, [expanded]);

  /* Panel enabled/disabled */
  useEffect(() => {
    void chrome.storage.local
      .get(PANEL_ENABLED_STORAGE_KEY)
      .then((r) => setPanelEnabled(Boolean(r[PANEL_ENABLED_STORAGE_KEY])));
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes, area,
    ) => {
      if (area !== "local" || !changes[PANEL_ENABLED_STORAGE_KEY]) return;
      setPanelEnabled(Boolean(changes[PANEL_ENABLED_STORAGE_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  /* Auto-scroll to latest */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, loading]);

  /**
   * Unified pointer handler: drag if movement > threshold, otherwise toggle panel.
   * Using pointer events (not onClick) so we can detect drag vs tap cleanly.
   */
  function onTagPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const startY = e.clientY;
    const startTop = shellTopRef.current;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) >= DRAG_THRESHOLD_PX) {
        moved = true;
        setDragging(true);
      }
      if (moved) {
        const h = shellRef.current?.offsetHeight ?? 80;
        setShellTopPx(clampShellTop(startTop + (ev.clientY - startY), h));
      }
    };

    const onUp = () => {
      if (moved) {
        void chrome.storage.local.set({
          [TAG_SHELL_TOP_STORAGE_KEY]: shellTopRef.current,
        });
      } else {
        setExpanded((ex) => !ex);
      }
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function toApiMessages(history: ChatTurn[]): ChatApiMessage[] {
    return history.map((x) =>
      x.role === "user"
        ? { role: "user", content: x.content }
        : { role: "assistant", content: x.content },
    );
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const userTurn: ChatTurn = { role: "user", content: text };
    const historyForApi = [...turns, userTurn];
    setTurns((prev) => [...prev, userTurn]);
    setLoading(true);
    setError(null);
    try {
      const data = await chatSearch(toApiMessages(historyForApi));
      setGmailAuthEmail(
        typeof data.gmailAuthEmail === "string" && data.gmailAuthEmail.trim()
          ? data.gmailAuthEmail.trim()
          : null,
      );
      setTurns([
        ...historyForApi,
        {
          role: "assistant",
          content: data.reply,
          results: data.results,
          isClarification: Boolean(data.clarification),
        },
      ]);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Is the backend running?",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function clearChat() {
    setTurns([]);
    setError(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function focusInput() {
    inputRef.current?.focus();
  }

  const lastTurnIsAssistant =
    turns.length > 0 && turns[turns.length - 1].role === "assistant";
  const showFollowUpActions = lastTurnIsAssistant && !loading && input === "";

  if (!panelEnabled) return null;

  return (
    <div ref={shellRef} className="ms-shell" style={{ top: shellTopPx }}>

      {/* ── Expanded panel ─────────────────────────────── */}
      {expanded && (
        <div className="ms-panel">
          <div className="popup-root">
            <div className="noise-bg" aria-hidden="true" />
            <div className="wrap wrap--chat wrap--dock">

              <header className="popup-header">
                <div className="mark">
                  <img
                    src={symbolUrl}
                    alt="mail-sherlock"
                    width={22}
                    height={22}
                    style={{ objectFit: "contain", flexShrink: 0 }}
                  />
                  <span>mail-sherlock</span>
                </div>
                <button
                  type="button"
                  className="ms-icon-btn"
                  onClick={() => setExpanded(false)}
                  title="Collapse"
                  aria-label="Collapse panel"
                >
                  ×
                </button>
              </header>

              <main className="chat-main">
                <p className="chat-intro">
                  Ask in plain English, then follow up — search uses your whole
                  conversation for context.
                </p>

                <div className="chat-scroll" role="log" aria-live="polite">
                  {turns.map((turn, i) =>
                    turn.role === "user" ? (
                      <div key={`u-${i}`} className="chat-bubble chat-bubble--user">
                        {turn.content}
                      </div>
                    ) : (
                      <div key={`a-${i}`} className={`chat-block chat-block--assistant${turn.isClarification ? " chat-block--clarification" : ""}`}>
                        <p className="assistant-label">{turn.content}</p>
                        {!turn.isClarification && (
                          <div className="assistant-results">
                            {turn.results.map((email) => (
                              <ResultCard
                                key={`${i}-${email.id}`}
                                email={email}
                                gmailAuthEmail={gmailAuthEmail}
                              />
                            ))}
                            {!loading && turn.results.length === 0 && (
                              <p className="empty">No messages matched.</p>
                            )}
                          </div>
                        )}
                        {i === turns.length - 1 && showFollowUpActions && !turn.isClarification && (
                          <div className="follow-up-actions">
                            <button
                              type="button"
                              className="btn-followup btn-followup--refine"
                              onClick={focusInput}
                            >
                              Refine results
                            </button>
                            <button
                              type="button"
                              className="btn-followup btn-followup--new"
                              onClick={clearChat}
                            >
                              New search
                            </button>
                          </div>
                        )}
                      </div>
                    ),
                  )}
                  {loading && (
                    <div className="chat-bubble chat-bubble--typing">
                      Searching…
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>

                {error && <p className="error">{error}</p>}

                <div className="composer-actions" />

                <div className="composer">
                  <textarea
                    ref={inputRef}
                    className="chat-input"
                    placeholder="e.g. emails about my lease…"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={2}
                    disabled={loading}
                    aria-label="Message"
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleSend()}
                    disabled={loading || !input.trim()}
                  >
                    {loading ? "…" : "Send"}
                  </button>
                </div>
              </main>

            </div>
          </div>
        </div>
      )}

      {/* ── Tag: click to toggle, drag to reposition ───── */}
      <button
        type="button"
        className={`ms-tag-main${dragging ? " ms-tag-main--dragging" : ""}`}
        onPointerDown={onTagPointerDown}
        title={expanded ? "Collapse mail-sherlock" : "Open mail-sherlock"}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse mail-sherlock" : "Open mail-sherlock"}
      >
        <img
          src={symbolUrl}
          alt=""
          width={26}
          height={26}
          style={{
            objectFit: "contain",
            display: "block",
            pointerEvents: "none",
            filter: "brightness(0) invert(1)",
            flexShrink: 0,
            position: "relative",
            zIndex: 1,          /* above the ::after dark overlay */
          }}
        />
        {/* Drag-handle dots — fade in on CSS :hover, no JS state needed */}
        <span className="ms-tag-dots" aria-hidden="true">
          <span className="ms-tag-dot" />
          <span className="ms-tag-dot" />
          <span className="ms-tag-dot" />
          <span className="ms-tag-dot" />
          <span className="ms-tag-dot" />
          <span className="ms-tag-dot" />
        </span>
      </button>

    </div>
  );
}
