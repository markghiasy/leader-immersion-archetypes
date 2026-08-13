"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import styles from "./scorecard.module.css";

/**
 * Invite link, copy button, native share sheet and a QR of the same link.
 * Everything renders from the URL prop; no network calls.
 */
export default function ShareBlock({ inviteUrl, ownerFirstName }: { inviteUrl: string; ownerFirstName: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Read from the browser without a state-setting effect, so the server render (no share
  // sheet) and the client render agree on the first paint.
  const canShare = useSyncExternalStore(
    () => () => {},
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
    () => false,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Rendered client-side so the page stays a plain cached HTML document.
    QRCode.toCanvas(canvas, inviteUrl, { width: 320, margin: 1, errorCorrectionLevel: "M" }).catch(() => {
      setStatus("The QR code could not be drawn — the link above still works.");
    });
  }, [inviteUrl]);

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
      <div className={styles.qrWrap}>
        <canvas ref={canvasRef} className={styles.qr} aria-label="QR code for your team invite link" role="img" />
        <p className="xs muted">Let someone scan this to join your team.</p>
      </div>
      <p className={styles.status} role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
