export interface Account {
  email: string;
  status: "active" | "cached" | "syncing" | "needs_login" | "failed";
  emailCount: number;
  lastSynced: number | null; // Unix timestamp
}

export interface AccountsResponse {
  active: string | null;
  accounts: Account[];
}

export interface Tag {
  label: string;
  bg: string;
  color: string;
}

export interface EmailResult {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date?: string;
  score?: number;
  account?: string;
  smartLabels?: string[];
  isUnread?: boolean;
  hasAttachment?: boolean;
  /* enriched client-side */
  initials?: string;
  avatarBg?: string;
  avatarColor?: string;
  tags?: Tag[];
}

export type AgentMode = "find" | "answer" | "summarize" | "extract" | "chitchat" | "clarify";

export interface SearchResponse {
  reply?: string;
  mode?: AgentMode;
  results: EmailResult[];
  gmailAuthEmail?: string | null;
  accounts?: string[];
  intent?: Record<string, unknown>;
  clarification?: string | null;
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
}

export interface EmailDetail {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  date: string;
  bodyHtml: string;
  bodyText: string;
  snippet: string;
  isUnread: boolean;
  hasAttachment: boolean;
  attachments: EmailAttachment[];
  smartLabels: string[];
  account: string;
}
