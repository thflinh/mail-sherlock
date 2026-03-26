import type { StoredSession } from "../types/chat";

const STORAGE_KEY = "mailSherlockChatHistory";

export async function loadSessionHistory(): Promise<StoredSession[]> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  const v = r[STORAGE_KEY];
  return Array.isArray(v) ? v : [];
}

export async function saveSessionToHistory(session: StoredSession): Promise<void> {
  const prev = await loadSessionHistory();
  const withoutDup = prev.filter((s) => s.id !== session.id);
  const next = [session, ...withoutDup].slice(0, 50);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

export async function deleteSessionFromHistory(id: string): Promise<void> {
  const prev = await loadSessionHistory();
  await chrome.storage.local.set({
    [STORAGE_KEY]: prev.filter((s) => s.id !== id),
  });
}
