/**
 * Environment access, in one place. Nothing here is Vercel-specific.
 */

const BASE_URL_MISSING =
  "BASE_URL is not set. Scorecard URLs, invite links, QR targets and email buttons are " +
  "all built from it at render time, and they are permanent by promise — an unset value " +
  "would silently publish links pointing at http://localhost:3000 while the app looked " +
  "healthy. Set it to the final public origin, no trailing slash.";

/**
 * Absolute base URL used to build share links, QR codes and email buttons.
 *
 * Fails loudly rather than falling back in production. The localhost fallback is a
 * development convenience; reaching it on a real host means every permanent link this
 * process hands out is wrong, and nothing else in the system would notice.
 */
export function baseUrl(): string {
  const explicit = process.env.BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  // Vercel sets this on preview deployments; harmless elsewhere and not required.
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  if (process.env.NODE_ENV === "production") throw new Error(BASE_URL_MISSING);
  return "http://localhost:3000";
}

/**
 * Boot-time gate, called from `instrumentation.ts` so a misconfigured container fails to
 * start instead of serving broken links. Checked here rather than only at render time
 * because the first render might be an attendee's scorecard, at the event.
 */
export function assertProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const problems: string[] = [];
  if (!process.env.BASE_URL?.trim() && !process.env.VERCEL_URL?.trim()) {
    problems.push(BASE_URL_MISSING);
  }
  if (!process.env.DATABASE_URL?.trim()) {
    problems.push("DATABASE_URL is not set. Nothing in this app works without it.");
  }

  if (problems.length > 0) {
    throw new Error(`Refusing to start:\n  - ${problems.join("\n  - ")}`);
  }
}

export function teamInviteUrl(teamSlug: string): string {
  return `${baseUrl()}/t/${teamSlug}`;
}

export function scorecardUrl(resultId: string): string {
  return `${baseUrl()}/r/${resultId}`;
}

/** Email is optional; the scorecard hides its email section entirely when unconfigured. */
export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export function emailFrom(): string {
  return process.env.EMAIL_FROM?.trim() || "Leader Archetype <onboarding@resend.dev>";
}

let warned = false;
export function warnIfEmailDisabled(): void {
  if (emailEnabled() || warned) return;
  warned = true;
  console.warn("[startup] RESEND_API_KEY is not set — the 'email me my scorecard' section is disabled.");
}

/**
 * INTAKE CLOSED — the exercise is over, but the results are not.
 *
 * Set `INTAKE_CLOSED=1` to stop new interviews. This deliberately does NOT take the app down:
 * 509 people hold permanent `/r/<id>` scorecard links that were mailed to them, and the whole
 * reason this runs on its own domain is that those links outlive the event. Closing intake must
 * therefore be a door, not a demolition.
 *
 * What it closes: the three entry pages and `POST /api/interview/start`, plus the legacy tap
 * form at `POST /api/submit`.
 *
 * What it deliberately leaves OPEN: `POST /api/interview/turn` and the draft-resume endpoint,
 * so the ~93 people who are mid-conversation can finish rather than being cut off after twenty
 * answers (Mark's call, 19 Aug). Drafts expire on their own at `draftTtlHours`, so intake goes
 * quiet by itself without anyone losing work. Also open: `/r/`, `/admin`, `/api/health`.
 *
 * A flag rather than deleted code, so it is reversible with one redeploy in either direction.
 * ⚠️ Env changes do not reach existing deployments — flipping this requires a redeploy.
 */
export function intakeClosed(): boolean {
  const value = process.env.INTAKE_CLOSED?.trim().toLowerCase();
  return value === "1" || value === "true";
}
