export function getStoredToken(): string | null {
  return localStorage.getItem("mailSherlockAuthToken");
}

export function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function authLoginUrl(): string {
  const token = getStoredToken();
  return token ? `/auth/login?token=${encodeURIComponent(token)}` : "/auth/login";
}
