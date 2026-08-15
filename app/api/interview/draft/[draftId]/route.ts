import { NextResponse } from "next/server";
import { resumeInterview } from "@/lib/interview/session";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { publicIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Draft ids are `nanoid(14)` and unguessable, but this endpoint returns a name, a transcript
 * and the answers behind it — so it is worth making enumeration expensive rather than only
 * improbable. Generous enough that a venue behind one NAT resuming after a wifi drop never
 * meets it.
 */
const RESUME_LIMIT = 600;
const RESUME_WINDOW_MS = 5 * 60_000;

/**
 * Rebuild an interview in progress.
 *
 * Called once on mount, with the id the client kept in sessionStorage. A 404 is the normal
 * answer, not an error: the draft has expired, was completed, or never existed. The client
 * clears its stale handle and opens a fresh interview.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;

  const parsed = publicIdSchema.safeParse(draftId);
  if (!parsed.success) {
    return NextResponse.json({ error: "No interview is in progress.", retryable: false }, { status: 404 });
  }

  const limit = rateLimit(`interview-resume:${clientIp(_request.headers)}`, RESUME_LIMIT, RESUME_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many attempts from this connection. Try again shortly.", retryable: true },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const resumed = await resumeInterview(parsed.data);
    if (!resumed) {
      return NextResponse.json({ error: "No interview is in progress.", retryable: false }, { status: 404 });
    }
    return NextResponse.json(resumed);
  } catch (error) {
    console.error("[interview/draft] resume failed", error instanceof Error ? error.message : error);
    // Deliberately not fatal to the person: a failed resume falls back to starting fresh,
    // which is exactly what happened before this endpoint existed.
    return NextResponse.json({ error: "Could not resume that interview.", retryable: true }, { status: 502 });
  }
}
