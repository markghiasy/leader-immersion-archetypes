"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Live viewport readout, for diagnosing device-specific scroll and keyboard behaviour.
 *
 * Renders ONLY when the URL carries ?debug=1, so it is invisible in normal use and to the
 * room. It exists because the interesting values here — the gap between the layout viewport
 * and the visual viewport, and what that does to the composer — cannot be reproduced on a
 * desktop and differ between Android and iOS. Reading them off the actual handset beats
 * guessing from a description of the symptom.
 *
 * Delete after the device pass; nothing depends on it.
 */
type Snapshot = {
  inner: number;
  vvHeight: number;
  vvOffsetTop: number;
  vvScale: number;
  inset: string;
  scrollY: number;
  docHeight: number;
  ua: string;
};

function read(): Snapshot {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  return {
    inner: Math.round(window.innerHeight),
    vvHeight: vv ? Math.round(vv.height) : -1,
    vvOffsetTop: vv ? Math.round(vv.offsetTop) : -1,
    vvScale: vv ? Number(vv.scale.toFixed(2)) : -1,
    inset: getComputedStyle(document.documentElement).getPropertyValue("--keyboard-inset").trim() || "unset",
    scrollY: Math.round(window.scrollY),
    docHeight: Math.round(document.documentElement.scrollHeight),
    ua: navigator.userAgent.slice(0, 48),
  };
}

export default function ViewportDebug() {
  // Read from the browser without a state-setting effect, so the server render and the first
  // client render agree — the same pattern ShareBlock uses for the share sheet.
  const on = useSyncExternalStore(
    () => () => {},
    () => new URLSearchParams(window.location.search).has("debug"),
    () => false,
  );
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!on) return;

    const tick = () => setSnap(read());
    // Deferred rather than called inline: a synchronous setState inside an effect triggers
    // a cascading render, and a debug readout is never worth one.
    const first = requestAnimationFrame(tick);

    const vv = window.visualViewport;
    window.addEventListener("scroll", tick, { passive: true });
    window.addEventListener("resize", tick);
    vv?.addEventListener("resize", tick);
    vv?.addEventListener("scroll", tick);
    return () => {
      cancelAnimationFrame(first);
      window.removeEventListener("scroll", tick);
      window.removeEventListener("resize", tick);
      vv?.removeEventListener("resize", tick);
      vv?.removeEventListener("scroll", tick);
    };
  }, [on]);

  if (!on || !snap) return null;

  const overlap = snap.vvHeight >= 0 ? snap.inner - snap.vvHeight - snap.vvOffsetTop : -1;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        zIndex: 9999,
        padding: "6px 8px",
        background: "rgba(0,0,0,0.82)",
        color: "#0f0",
        font: "11px/1.35 ui-monospace, monospace",
        pointerEvents: "none",
        maxWidth: "100vw",
        whiteSpace: "pre",
      }}
    >
      {`inner   ${snap.inner}
vv.h    ${snap.vvHeight}   off ${snap.vvOffsetTop}  scale ${snap.vvScale}
overlap ${overlap}   inset ${snap.inset}
scrollY ${snap.scrollY}  doc ${snap.docHeight}
${snap.ua}`}
    </div>
  );
}
