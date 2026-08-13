import { Resend } from "resend";
import { allArchetypes, archetypeFor, archetypeTitle } from "./content";
import { emailTokens as t } from "./email-theme";
import { emailFrom, scorecardUrl } from "./env";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type ScorecardEmailInput = { firstName: string; profile: number; resultId: string; totals: number[] };

/** Table-based HTML so it survives Outlook; tokens mirrored from theme.css. */
export function renderScorecardEmail({ firstName, profile, resultId, totals }: ScorecardEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const archetype = archetypeFor(profile);
  const title = archetypeTitle(profile);
  const url = scorecardUrl(resultId);

  const list = (items: string[], colour: string, background: string) =>
    items
      .map(
        (item) =>
          `<tr><td style="padding:8px 14px;background:${background};color:${colour};border:1px solid ${
            t["--color-border"]
          };border-radius:8px;font-size:15px;">${escapeHtml(
            item,
          )}</td></tr><tr><td style="height:8px;line-height:8px;">&nbsp;</td></tr>`,
      )
      .join("");

  // The profile shape, as table cells — email clients do not render SVG reliably, so the
  // emblem stays on the web scorecard and the chart travels in its place.
  const max = Math.max(...totals, 1);
  const shape = allArchetypes
    .map((a) => {
      const total = totals[a.profile - 1] ?? 0;
      const pct = Math.round((total / max) * 100);
      const isWinner = a.profile === profile;
      const ink = isWinner ? t["--color-text"] : t["--color-border-strong"];
      const filled = pct > 0 ? `<td width="${pct}%" style="background:${ink};font-size:0;line-height:0;">&nbsp;</td>` : "";
      return `<tr>
        <td width="34%" style="padding:4px 8px 4px 0;font-size:12px;color:${
          isWinner ? t["--color-text"] : t["--color-text-muted"]
        };font-weight:${isWinner ? 700 : 400};">${escapeHtml(a.name.replace(/^The /, ""))}</td>
        <td style="padding:4px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:8px;background:${
            t["--color-surface-muted"]
          };border-radius:4px;"><tr>${filled}<td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>
        </td>
        <td width="26" align="right" style="padding:4px 0 4px 8px;font-size:12px;color:${
          t["--color-text-muted"]
        };">${total}</td>
      </tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="en-AU">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title,
  )}</title></head>
<body style="margin:0;padding:0;background:${t["--color-surface-muted"]};font-family:${t["--font-sans"]};color:${
    t["--color-text"]
  };">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${
    t["--color-surface-muted"]
  };padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${
        t["--color-bg"]
      };border:1px solid ${t["--color-border"]};border-radius:18px;padding:28px;">
        <tr><td>
          <p style="margin:0 0 6px;font-size:14px;color:${t["--color-text-muted"]};">Hello ${escapeHtml(
            firstName,
          )}, here is your scorecard.</p>
          <h1 style="margin:0 0 8px;font-size:26px;line-height:1.2;color:${t["--color-text"]};">${escapeHtml(
            title,
          )}</h1>
          <p style="margin:0 0 18px;font-size:16px;color:${t["--color-text-muted"]};">${escapeHtml(
            archetype.essence,
          )}</p>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.55;">${escapeHtml(archetype.description)}</p>

          <p style="margin:0 0 10px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${
            t["--color-text-muted"]
          };font-weight:700;">Your profile shape</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">${shape}</table>

          <p style="margin:0 0 10px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${
            t["--color-text-muted"]
          };font-weight:700;">Your strengths</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list(
            archetype.strengths,
            t["--color-strength"],
            t["--color-strength-bg"],
          )}</table>

          <p style="margin:10px 0 10px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${
            t["--color-text-muted"]
          };font-weight:700;">Watch-outs</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list(
            archetype.watchouts,
            t["--color-watchout"],
            t["--color-watchout-bg"],
          )}</table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
            <tr><td align="center" style="background:${t["--color-accent"]};border-radius:999px;">
              <a href="${url}" style="display:inline-block;padding:14px 28px;color:${
                t["--color-on-accent"]
              };font-size:16px;font-weight:600;text-decoration:none;">View your scorecard and invite your team</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:13px;color:${
            t["--color-text-muted"]
          };">Your scorecard lives at <a href="${url}" style="color:${t["--color-accent"]};">${escapeHtml(
            url,
          )}</a> — it stays there, so you can come back any time.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hello ${firstName}, here is your scorecard.`,
    "",
    title,
    archetype.essence,
    "",
    archetype.description,
    "",
    "Your profile shape:",
    ...allArchetypes.map((a) => `- ${a.name.replace(/^The /, "")}: ${totals[a.profile - 1] ?? 0}`),
    "",
    "Your strengths:",
    ...archetype.strengths.map((s) => `- ${s}`),
    "",
    "Watch-outs:",
    ...archetype.watchouts.map((s) => `- ${s}`),
    "",
    `View your scorecard and invite your team: ${url}`,
  ].join("\n");

  return { subject: `Your Leader Archetype: ${archetype.name}`, html, text };
}

export async function sendScorecardEmail(to: string, input: ScorecardEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");

  const { subject, html, text } = renderScorecardEmail(input);
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({ from: emailFrom(), to, subject, html, text });
  if (error) throw new Error(error.message);
}
