"use client";

import { useEffect } from "react";

/** Shown when a server render fails — most plausibly a database outage mid-event. */
export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[render] ", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="page">
      <main className="container">
        <div className="stack" style={{ paddingTop: "var(--space-7)" }}>
          <h1>Something went wrong at our end</h1>
          <p className="muted">
            This is us, not you. Your scorecard link is permanent, so try again in a moment and it will still be there.
          </p>
          <button type="button" className="button" onClick={reset}>
            Try again
          </button>
        </div>
      </main>
    </div>
  );
}
