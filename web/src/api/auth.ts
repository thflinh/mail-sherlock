export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export interface AuthResponse {
  ok: boolean;
  token: string;
  user: AuthUser;
}

export async function signupEmail(input: {
  name: string;
  email: string;
  password: string;
}): Promise<AuthResponse> {
  const res = await fetch("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as { detail?: string }).detail ?? `Signup failed (${res.status})`);
  }
  return res.json() as Promise<AuthResponse>;
}

export async function loginEmail(input: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  const res = await fetch("/auth/login/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as { detail?: string }).detail ?? `Login failed (${res.status})`);
  }
  return res.json() as Promise<AuthResponse>;
}

export async function getSession(token: string): Promise<{ authenticated: boolean; user?: AuthUser }> {
  const res = await fetch(`/auth/session?token=${encodeURIComponent(token)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Session check failed (${res.status})`);
  return res.json() as Promise<{ authenticated: boolean; user?: AuthUser }>;
}

export async function logoutSession(token: string): Promise<void> {
  await fetch("/auth/session/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}
