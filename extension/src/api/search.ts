const API_URL = "http://localhost:8000";

export interface EmailResult {
  id: string;
  subject: string;
  sender: string;
  date: string;
  body: string;
  score: number;
}

export interface SearchResponse {
  results: EmailResult[];
}

export async function searchEmails(query: string, topK = 5): Promise<SearchResponse> {
  const res = await fetch(`${API_URL}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: topK }),
  });

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }

  return res.json();
}
