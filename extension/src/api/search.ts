// Use 127.0.0.1 so Windows does not prefer IPv6 (::1) while uvicorn listens on IPv4.
const API_URL = "http://127.0.0.1:8000";

export interface EmailResult {
  id: string;
  /** Gmail thread id — present after Gmail sync; used to open the thread in the web app. */
  threadId?: string;
  subject: string;
  sender: string;
  date: string;
  body: string;
  score: number;
}

/**
 * Opens the thread in Gmail for the same Google account that OAuth’d with mail-sherlock
 * (uses Google’s authuser= so the browser picks that identity, not default /u/0).
 */
export function gmailWebUrlForThread(
  threadId: string,
  gmailAuthEmail: string
): string {
  const u = new URL("https://mail.google.com/mail/u/0/");
  u.searchParams.set("authuser", gmailAuthEmail.trim());
  u.hash = `#all/${threadId}`;
  return u.toString();
}

export interface SearchResponse {
  results: EmailResult[];
  /** Set after Gmail sync — required to build correct “Open in Gmail” links. */
  gmailAuthEmail?: string | null;
}

async function errorMessageFromResponse(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { detail?: unknown };
    const d = data.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d))
      return d.map((x: { msg?: string }) => x.msg ?? String(x)).join("; ");
    if (d != null) return String(d);
  } catch {
    /* not JSON */
  }
  return text.trim() || `HTTP ${res.status}`;
}

export async function searchEmails(
  query: string,
  topK = 5
): Promise<SearchResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: topK }),
    });
  } catch (e) {
    const hint =
      e instanceof TypeError
        ? " (network error — is the backend running on port 8000?)"
        : "";
    throw new Error(`${e instanceof Error ? e.message : String(e)}${hint}`);
  }

  if (!res.ok) {
    const detail = await errorMessageFromResponse(res);
    throw new Error(`Request failed (${res.status}): ${detail}`);
  }

  return res.json();
}
