import { NextResponse } from "next/server";
import { createCompletion, knownEventSlugs, teamIdBySlug } from "@/lib/queries";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { score } from "@/lib/scoring";
import { fieldErrors, submitSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Generous by design: a venue full of people shares one NAT address. */
const SUBMIT_LIMIT = 120;
const SUBMIT_WINDOW_MS = 5 * 60_000;

export async function POST(request: Request) {
  const limit = rateLimit(`submit:${clientIp(request.headers)}`, SUBMIT_LIMIT, SUBMIT_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many submissions from this connection. Try again shortly." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please check your details and answers.", fields: fieldErrors(parsed.error, "contact") },
      { status: 400 },
    );
  }

  const { contact, answers, event, teamSlug } = parsed.data;

  // Scoring is server-side only. The client has never seen the profile mappings.
  const scored = score(answers);

  try {
    // A team link wins over an event slug: attribution to a person is the growth loop.
    const teamId = teamSlug ? await teamIdBySlug(teamSlug) : null;
    const eventSlug = event && (await knownEventSlugs()).has(event) ? event : null;

    const { resultId } = await createCompletion({ contact, answers, scored, eventSlug, teamId });
    return NextResponse.json({ resultId }, { status: 201 });
  } catch (error) {
    // Never log the payload: it is all PII.
    console.error("[submit] failed to record completion", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "We could not save your answers just then. Please try again." }, { status: 503 });
  }
}
