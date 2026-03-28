import { useState } from "react";
import "./App.css";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";

export type Page = "landing" | "dashboard";

export default function App() {
  const [page, setPage] = useState<Page>(() =>
    window.location.hash === "#/dashboard" ? "dashboard" : "landing",
  );

  function navigate(to: Page) {
    window.location.hash = to === "dashboard" ? "#/dashboard" : "";
    setPage(to);
  }

  if (page === "dashboard") return <Dashboard navigate={navigate} />;
  return <Landing navigate={navigate} />;
}
