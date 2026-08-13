"use client";

import { useState } from "react";
import styles from "./scorecard.module.css";

export default function EmailScorecard({ resultId, defaultEmail }: { resultId: string; defaultEmail: string }) {
  const [email, setEmail] = useState(defaultEmail);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");
    setMessage(null);
    try {
      const response = await fetch("/api/email-scorecard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resultId, email }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error || "We could not send that email just then.");
      setState("sent");
      setMessage("Sent. Check your inbox in a moment.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Something went wrong.");
    }
  }

  return (
    <form onSubmit={send}>
      <div className={styles.emailRow}>
        <div className="field">
          <label htmlFor="scorecard-email">Email address</label>
          <input
            id="scorecard-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <button type="submit" className="button" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Send it to me"}
        </button>
      </div>
      <p className={styles.status} role="status" aria-live="polite">
        {message}
      </p>
    </form>
  );
}
