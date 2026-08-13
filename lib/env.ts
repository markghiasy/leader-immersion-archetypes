/**
 * Environment access, in one place. Nothing here is Vercel-specific.
 */

/** Absolute base URL used to build share links, QR codes and email buttons. */
export function baseUrl(): string {
  const explicit = process.env.BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  // Vercel sets this on preview deployments; harmless elsewhere and not required.
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  return "http://localhost:3000";
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
