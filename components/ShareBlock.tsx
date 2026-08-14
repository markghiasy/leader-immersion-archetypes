"use client";

import { useState, useSyncExternalStore } from "react";
import styles from "./scorecard.module.css";

/**
 * Invite link, copy button and the native share sheet. Everything renders from the URL
 * prop; no network calls.
 *
 * No QR here on purpose. This block is read by someone already holding the phone the
 * scorecard is on, so a QR of their own invite link is a code they cannot scan — the copy
 * button and the share sheet are what actually move the link to another person.
 */
export default function ShareBlock({ inviteUrl, ownerFirstName }: { inviteUrl: string; ownerFirstName: string }) {
  const [status, setStatus] = useState<string | null>(null);
  // Read from the browser without a state-setting effect, so the server render (no share
  // sheet) and the client render agree on the first paint.
  const canShare = useSyncExternalStore(
    () => () => {},
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
    () => false,
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setStatus("Link copied.");
    } catch {
      setStatus("Copy is blocked in this browser — select the link above and copy it manually.");
    }
  }

  async function share() {
    const data = {
      title: "Discover your Leader Archetype",
      text: `${ownerFirstName} invited you to discover your Leader Archetype.`,
      url: inviteUrl,
    };
    try {
      if (navigator.share) {
        await navigator.share(data);
        return;
      }
      await copy();
    } catch (error) {
      // A cancelled share sheet is not an error worth showing.
      if (error instanceof DOMException && error.name === "AbortError") return;
      await copy();
    }
  }

  return (
    <div>
      <p className={styles.shareUrl}>{inviteUrl}</p>
      <div className={styles.shareButtons}>
        <button type="button" className="button" onClick={copy}>
          Copy link
        </button>
        {canShare && (
          <button type="button" className="button button-secondary" onClick={share}>
            Share
          </button>
        )}
      </div>
      <p className={styles.status} role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
