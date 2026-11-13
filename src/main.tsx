import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { record } from "./lib/diag";
import "./styles.css";

// Catch failures that happen outside React's render path (failed chunk loads,
// async throws) so they show up in the diagnostics panel instead of vanishing.
window.addEventListener("error", (e) => {
  record("error", "window.error", {
    message: e.message,
    source: e.filename,
    line: e.lineno,
  });
});

window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { message?: string } | undefined;
  record("error", "unhandledrejection", {
    message: reason?.message ?? String(e.reason),
  });
});

record("info", "boot", { href: location.href, online: navigator.onLine });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
