import { useEffect, useState } from "react";
import "./App.css";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import { getSession } from "./api/auth";

export type Page = "landing" | "dashboard";

export default function App() {
  const [page, setPage] = useState<Page>("landing");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const token = localStorage.getItem("mailSherlockAuthToken");
        const [session, status] = await Promise.all([
          token ? getSession(token).catch(() => ({ authenticated: false })) : Promise.resolve({ authenticated: false }),
          fetch("/status", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
        ]);
        const hasGmailAuth = !!status.gmailAuthEmail || (Array.isArray(status.accounts) && status.accounts.length > 0);
        const hashWantsDashboard = window.location.hash === "#/dashboard";
        const shouldUseDashboard = hashWantsDashboard || session.authenticated || hasGmailAuth;
        if (!cancelled) {
          setPage(shouldUseDashboard ? "dashboard" : "landing");
          if (shouldUseDashboard) window.location.hash = "#/dashboard";
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  function navigate(to: Page) {
    window.location.hash = to === "dashboard" ? "#/dashboard" : "";
    if (to === "dashboard") localStorage.setItem("mailSherlockLastPage", "dashboard");
    else localStorage.removeItem("mailSherlockLastPage");
    setPage(to);
  }

  if (!ready) return null;
  if (page === "dashboard") return <Dashboard navigate={navigate} />;
  return <Landing />;
}
