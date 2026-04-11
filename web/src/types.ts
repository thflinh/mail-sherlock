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
  /* enriched client-side */
  initials?: string;
  avatarBg?: string;
  avatarColor?: string;
  tags?: Tag[];
}

export interface SearchResponse {
  reply?: string;
  results: EmailResult[];
  gmailAuthEmail?: string | null;
  /** Connected Gmail addresses (order preserved; first is primary for greetings). */
  accounts?: string[];
  intent?: Record<string, unknown>;
}
