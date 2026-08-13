import { NextResponse } from "next/server";
import { INTERVIEW_LIMITS, type ApiError, type TurnRequest, type TurnResponse } from "@/lib/interview/contract";
import { takeTurn } from "@/lib/interview/session";
import { turnRequestSchema } from "@/lib/interview/validation";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/interview/turn — take one move and return the next.
 *
 * Everything the person says arrives here, so this route's job is to say as little as
 * possible: validate the move, protect the draft, hand it to the session, and pass the
 * session's own `TurnResponse` back untouched. `continue`, `complete` and `fallback` are
 * all successful outcomes — the tap-form fallback in particular is the designed floor, not
 * an error, and must never be returned as one.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TURN_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request.", false, 400);
  }

  const parsed = turnRequestSchema.safeParse(body);
  if (!parsed.success) {
    // Deliberately terse and never echoed back: the body holds what the person typed, and
    // no failure here is worth quoting it in an error string.
    return fail(parsed.error.issues[0]?.message ?? "We could not read that.", false, 400);
  }

  const payload: TurnRequest = parsed.data;

  // Per draft, not per IP. A whole room shares one address, so an IP key would throttle a
  // venue; the draft is also the thing worth protecting, since holding its id is all it
  // takes to add turns to someone's interview.
  const limit = rateLimit(`interview-turn:${payload.draftId}`, INTERVIEW_LIMITS.turnsPerMinute, TURN_WINDOW_MS);
  if (!limit.ok) {
    return fail("That is faster than we can keep up with. Give it a moment.", true, 429, {
      "retry-after": String(limit.retryAfterSeconds),
    });
  }

  try {
    const next: TurnResponse = await takeTurn(payload);
    return NextResponse.json(next);
  } catch (error) {
    return failure(error);
  }
}

/**
 * A dead draft and a failed model call are different answers to "should I try again?", and
 * getting that wrong is expensive in both directions: a client that retries a draft which
 * no longer exists loops forever, and one that gives up on a transient model error loses an
 * interview a retry would have saved.
 *
 * The session marks the first kind with a `code`; anything unrecognised is treated as
 * transient, because an unknown fault is far more often a blip than a lost draft.
 */
function failure(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;

  if (code === "draft_not_found") {
    return fail("We could not find that conversation. Please start again.", false, 404);
  }
  if (code === "draft_expired") {
    return fail(
      `That conversation has been idle more than ${INTERVIEW_LIMITS.draftTtlHours} hours. Please start again.`,
      false,
      410,
    );
  }

  // Never log the reply, the transcript or the contact — it is all PII. The draft id stays
  // out too: it is a bearer handle, and a log line is a poor place to keep one.
  console.error("[interview/turn] turn failed", error instanceof Error ? error.message : error);
  return fail("We lost the thread just then. Please try that again.", true, 503);
}

function fail(error: string, retryable: boolean, status: number, headers?: Record<string, string>) {
  return NextResponse.json({ error, retryable } satisfies ApiError, { status, headers });
}
