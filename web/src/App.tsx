import { useEffect, useState } from "react";
import "./App.css";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import { getSession } from "./api/auth";

const GA_ID = "G-997MB7GN9C";

function sendGtagPageView() {
  if (typeof window.gtag !== "function") return;
  const pagePath =
    window.location.pathname + window.location.search + window.location.hash;
  window.gtag("config", GA_ID, { page_path: pagePath });
}

export type Page = "landing" | "dashboard" | "privacy" | "terms";

function pageFromHash(hash: string): Page {
  if (hash === "#/dashboard") return "dashboard";
  if (hash === "#/privacy") return "privacy";
  if (hash === "#/terms") return "terms";
  return "landing";
}

export default function App() {
  const [page, setPage] = useState<Page>("landing");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const hashPage = pageFromHash(window.location.hash);
        if (hashPage === "privacy" || hashPage === "terms") {
          if (!cancelled) setPage(hashPage);
          return;
        }
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

  useEffect(() => {
    function onHashChange() {
      setPage(pageFromHash(window.location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    sendGtagPageView();
  }, [ready, page]);

  function navigate(to: Page) {
    window.location.hash = to === "dashboard" ? "#/dashboard" : "";
    if (to === "dashboard") localStorage.setItem("mailSherlockLastPage", "dashboard");
    else localStorage.removeItem("mailSherlockLastPage");
    setPage(to);
  }

  if (!ready) return null;
  if (page === "dashboard") return <Dashboard navigate={navigate} />;
  if (page === "privacy") return <Privacy />;
  if (page === "terms") return <Terms />;
  return <Landing />;
}
