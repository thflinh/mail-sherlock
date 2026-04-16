import type { EmailResult } from "../api/search";

export type ChatTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; results: EmailResult[]; isClarification?: boolean };

export interface StoredSession {
  id: string;
  savedAt: number;
  turns: ChatTurn[];
  gmailAuthEmail: string | null;
}
