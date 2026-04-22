import { authHeaders } from "./http";

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  description?: string;
  source: "manual" | "from_email";
  source_email_id?: string;
}

export async function getEvents(): Promise<CalendarEvent[]> {
  const res = await fetch("/events", { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to load events (${res.status})`);
  const data = (await res.json()) as { events?: CalendarEvent[] };
  return Array.isArray(data.events) ? data.events : [];
}

export async function createEvent(input: {
  title: string;
  date: string;
  time?: string;
  description?: string;
  source_email_id?: string;
}): Promise<CalendarEvent> {
  const res = await fetch("/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to create event (${res.status})`);
  const data = (await res.json()) as { event: CalendarEvent };
  return data.event;
}

export async function deleteEvent(id: string): Promise<void> {
  const res = await fetch(`/events/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to delete event (${res.status})`);
}
