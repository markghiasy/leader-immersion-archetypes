import { NextResponse } from "next/server";
import type { ApiError, StartRequest, StartResponse } from "@/lib/interview/contract";
import { startInterview } from "@/lib/interview/session";
import { startRequestSchema } from "@/lib/interview/validation";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { fieldErrors } from "@/lib/validation";

/**
 * POST /api/interview/start — open a draft and return the first agent turn.
 *
 * The interview is now the primary journey, so this endpoint sits where the tap form's
 * submit used to: it is the first thing a person hits after the QR code. It creates the
 * draft and phrases the opening question; nothing is written to `responses` until the last
 * turn settles all 25.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Keyed per IP and deliberately generous, for the same reason /api/submit is: a room full
 * of people scanning the same QR code shares one venue NAT, and being turned away at the
 * door is the one failure this build cannot afford. A start costs a single short phrasing
 * call, so the ceiling is about abuse, not spend.
 */
const START_LIMIT = 2000;
const START_WINDOW_MS = 5 * 60_000;
// 2000 per five minutes, not 120: a whole venue shares one NAT address, and the design
// target is 1000 people starting within minutes of each other. A limit below the stated
// load is not abuse protection, it is an outage.

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request.", false, 400);
  }

  const parsed = startRequestSchema.safeParse(body);
  if (!parsed.success) {
    // `fields` rides alongside the ApiError shape rather than replacing it, so the contact
    // step can mark the offending input the way the tap form does. A consumer that only
    // knows about ApiError is unaffected.
    return NextResponse.json(
      {
        error: "Please check your details.",
        retryable: false,
        fields: fieldErrors(parsed.error, "contact"),
      } satisfies ApiError & { fields: Record<string, string> },
      { status: 400 },
    );
  }

  const limit = rateLimit(`interview-start:${clientIp(request.headers)}`, START_LIMIT, START_WINDOW_MS);
  if (!limit.ok) {
    return fail("Too many starts from this connection. Try again shortly.", true, 429, {
      "retry-after": String(limit.retryAfterSeconds),
    });
  }

  const payload: StartRequest = parsed.data;

  try {
    const started: StartResponse = await startInterview(payload);
    return NextResponse.json(started, { status: 201 });
  } catch (error) {
    // Never log the payload: it is all PII. The opening turn needs a model call, so the
    // usual cause here is an upstream blip — retryable, and the client can simply ask again.
    console.error("[interview/start] could not open a draft", error instanceof Error ? error.message : error);
    return fail("We could not start that just then. Please try again.", true, 503);
  }
}

function fail(error: string, retryable: boolean, status: number, headers?: Record<string, string>) {
  return NextResponse.json({ error, retryable } satisfies ApiError, { status, headers });
}
