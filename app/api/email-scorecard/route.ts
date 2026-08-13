import { NextResponse } from "next/server";
import { sendScorecardEmail } from "@/lib/email";
import { emailEnabled } from "@/lib/env";
import { responseForEmail } from "@/lib/queries";
import { rateLimit } from "@/lib/rate-limit";
import { emailScorecardSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEND_LIMIT = 3;
const SEND_WINDOW_MS = 60 * 60_000;

export async function POST(request: Request) {
  if (!emailEnabled()) {
    return NextResponse.json({ error: "Email is not configured." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = emailScorecardSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const { resultId, email } = parsed.data;

  // Per scorecard, not per IP: this is the lever that could be used to send mail to
  // someone else, so the limit belongs to the thing being sent.
  const limit = rateLimit(`email:${resultId}`, SEND_LIMIT, SEND_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "This scorecard has already been emailed three times this hour. Try again later." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const response = await responseForEmail(resultId);
    if (!response) return NextResponse.json({ error: "Scorecard not found." }, { status: 404 });

    await sendScorecardEmail(email, {
      firstName: response.firstName,
      profile: response.profile,
      resultId: response.id,
      totals: response.totals,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[email-scorecard] send failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "We could not send that email just then. Please try again." }, { status: 502 });
  }
}
