import type { AccountsResponse } from "../types";

export async function getAccounts(): Promise<AccountsResponse> {
  const res = await fetch("/accounts");
  if (!res.ok) throw new Error(`Failed to load accounts (${res.status})`);
  return res.json() as Promise<AccountsResponse>;
}

export async function switchAccount(
  email: string,
): Promise<{ active: string; emailCount: number; status: string }> {
  const res = await fetch("/accounts/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as { detail?: string }).detail ?? `Switch failed (${res.status})`);
  }
  return res.json();
}
