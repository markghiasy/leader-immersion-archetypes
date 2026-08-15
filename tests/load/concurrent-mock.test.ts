import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb, teardownTestDb } from "../helpers/test-db";
import { interviewDrafts, responses, teams } from "@/lib/schema";
import { resetRateLimits } from "@/lib/rate-limit";
import { clientQuestions, QUESTION_COUNT } from "@/lib/scoring";
import type { StartResponse, TurnRequest, TurnResponse } from "@/lib/interview/contract";
import { publicId } from "@/lib/ids";

/**
 * CONCURRENT MOCK LOAD TEST — not part of `npm test`.
 *
 * Drives many simulated people through the real /api/interview/start and /api/interview/turn
 * route handlers AT ONCE, against real Postgres semantics (PGlite — see the caveat below),
 * with the Anthropic calls replaced by a stub that adds configurable artificial latency
 * instead of a real model call. The point is to put load on OUR code — the atomic-completion
 * fix, the retry-idempotency fix, the rate limiter, the controller — without spending real
 * Anthropic money or needing production credentials.
 *
 * Skipped by default (see `describe.skipIf` below) because it is slow and its whole point is
 * concurrency, which has no place in the ordinary `npm test` / CI run. To run it:
 *
 *   RUN_LOAD_TEST=1 npx vitest run tests/load/concurrent-mock.test.ts
 *
 * Tune with env vars (all optional, defaults below are a fast dev-loop pass, not a realistic
 * one — see the PEOPLE/THINK_MS/MODEL_LATENCY_MS block):
 *
 *   PEOPLE=200 THINK_MIN_MS=2000 THINK_MAX_MS=8000 MODEL_LATENCY_MIN_MS=1500 \
 *     MODEL_LATENCY_MAX_MS=4000 LOST_RESPONSE_RATE=0.05 \
 *     RUN_LOAD_TEST=1 npx vitest run tests/load/concurrent-mock.test.ts
 *
 * CAVEAT — what this does and does not prove:
 *
 *   - PGlite is a real, ACID Postgres engine, so this DOES exercise real transactions, real
 *     locking, real constraint enforcement. A race in the atomic-completion fix or the
 *     retry-idempotency fix would show up here as a duplicate response row or a failed
 *     invariant check below.
 *   - PGlite runs in-process with no network round trip and no separate `max_connections`
 *     ceiling, so this CANNOT show whether Vercel's instance count × DB_POOL_MAX would
 *     exhaust Neon's real connection limit. That question needs a real network Postgres —
 *     `docker compose up -d` (local, closest to "direct" Neon) or a real Neon test branch
 *     once one exists. Swapping the driver is a matter of pointing DATABASE_URL at one
 *     instead of calling createTestDb(); nothing else in this file would need to change,
 *     since it talks to the app through the same route handlers either way.
 *   - The Anthropic call is stubbed, so this says nothing about model latency, 429s, or the
 *     personal-vs-business key question. Those need the real API.
 */

const PEOPLE = Number(process.env.PEOPLE ?? 40);
// Default pacing must stay under INTERVIEW_LIMITS.turnsPerMinute (30) per draft even after
// occasional retries, or the per-draft rate limiter — abuse protection, working as intended —
// trips and gets misread as this test finding a bug. ~2.5s/turn average keeps real headroom.
const THINK_MS = { min: Number(process.env.THINK_MIN_MS ?? 1500), max: Number(process.env.THINK_MAX_MS ?? 3500) };
const MODEL_LATENCY_MS = { min: Number(process.env.MODEL_LATENCY_MIN_MS ?? 50), max: Number(process.env.MODEL_LATENCY_MAX_MS ?? 200) };
/** Fraction of turns where we simulate a lost response by resending the identical request —
 * the exact failure mode audit finding #1 closes. Directly exercises that fix under load. */
const LOST_RESPONSE_RATE = Number(process.env.LOST_RESPONSE_RATE ?? 0.1);
const MAX_TURNS_PER_PERSON = 60;

const models = vi.hoisted(() => ({
  extract: vi.fn<typeof import("@/lib/interview/extractor").extract>(),
  askFor: vi.fn<typeof import("@/lib/interview/phrasing").askFor>(),
}));

vi.mock("@/lib/interview/extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/interview/extractor")>()),
  extract: models.extract,
}));

vi.mock("@/lib/interview/phrasing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/interview/phrasing")>()),
  askFor: models.askFor,
}));

/** Structural equality, order-independent for object keys — see the note at its call site. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function delay(range: { min: number; max: number }): Promise<void> {
  const ms = range.min + Math.random() * (range.max - range.min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a person plausibly types when they mean option `value` — same trick tests/
 * interview-session.test.ts uses, generalised so the stub extractor can read it back. */
function replyChoosing(questionIndex: number, value: number): string {
  return `Honestly, ${clientQuestions[questionIndex].options[value]} — that's just how I work.`;
}

let harness: Awaited<ReturnType<typeof createTestDb>>;
let startRoute: typeof import("@/app/api/interview/start/route").POST;
let turnRoute: typeof import("@/app/api/interview/turn/route").POST;

describe.skipIf(!process.env.RUN_LOAD_TEST)("concurrent mock load test", () => {
  beforeAll(async () => {
    harness = await createTestDb();
    // Imported after the mocks above are registered and the test db exists, matching the
    // pattern tests/interview-session.test.ts relies on for the same reason.
    ({ POST: startRoute } = await import("@/app/api/interview/start/route"));
    ({ POST: turnRoute } = await import("@/app/api/interview/turn/route"));
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb(harness.db);
    await harness.db.delete(interviewDrafts);
    resetRateLimits();

    models.extract.mockReset();
    models.askFor.mockReset();

    models.extract.mockImplementation(async (openQuestions, utterance) => {
      await delay(MODEL_LATENCY_MS);
      const qi = openQuestions[0];
      if (qi === undefined) return [];
      const value = clientQuestions[qi].options.findIndex((opt) => utterance.includes(opt));
      if (value === -1) return [];
      return [
        {
          questionIndex: qi,
          value,
          confidence: 0.95,
          certainty: "explicit",
          quote: clientQuestions[qi].options[value],
        },
      ];
    });

    models.askFor.mockImplementation(async (questionText) => {
      await delay(MODEL_LATENCY_MS);
      return { text: `Right — ${questionText}`, verbatimPreserved: true };
    });
  });

  function request(path: string, body: unknown): Request {
    return new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` },
      body: JSON.stringify(body),
    });
  }

  async function callStart(personIndex: number): Promise<{ ok: true; data: StartResponse } | { ok: false; status: number }> {
    const response = await startRoute(
      request("/api/interview/start", {
        contact: {
          firstName: "Load",
          lastName: `Test${personIndex}`,
          email: `load-test-${personIndex}@example.com`,
          mobile: `0400 ${String(personIndex).padStart(6, "0")}`,
          company: null,
        },
      }),
    );
    if (response.status !== 201) return { ok: false, status: response.status };
    return { ok: true, data: (await response.json()) as StartResponse };
  }

  async function callTurn(body: TurnRequest): Promise<{ ok: true; data: TurnResponse; ms: number } | { ok: false; status: number; ms: number }> {
    const startedAt = Date.now();
    const response = await turnRoute(request("/api/interview/turn", body));
    const ms = Date.now() - startedAt;
    if (response.status !== 200) return { ok: false, status: response.status, ms };
    return { ok: true, data: (await response.json()) as TurnResponse, ms };
  }

  type PersonOutcome =
    | { personIndex: number; outcome: "completed"; resultId: string; turns: number; retries: number }
    | { personIndex: number; outcome: "failed"; reason: string; turns: number; retries: number };

  async function runPerson(personIndex: number, turnLatencies: number[]): Promise<PersonOutcome> {
    const started = await callStart(personIndex);
    if (!started.ok) return { personIndex, outcome: "failed", reason: `start:${started.status}`, turns: 0, retries: 0 };

    const draftId = started.data.draftId;
    let ask = started.data.ask;
    const answers = Array.from({ length: QUESTION_COUNT }, () => Math.floor(Math.random() * 4));
    let retries = 0;

    for (let turns = 1; turns <= MAX_TURNS_PER_PERSON; turns += 1) {
      await delay(THINK_MS);
      const qi = ask.questionIndex;
      const body: TurnRequest = { draftId, requestId: publicId(), reply: replyChoosing(qi, answers[qi]) };

      const result = await callTurn(body);
      if (!result.ok) return { personIndex, outcome: "failed", reason: `turn:${result.status}`, turns, retries };
      turnLatencies.push(result.ms);

      if (result.data.status === "complete") {
        // The completing turn is deliberately NOT retried here. Once it succeeds, the draft
        // is consumed atomically (audit finding #2) — a resend of this exact request is
        // correctly reported as "already completed" (404), not replayed, because there is no
        // resultId left to hand back from a deleted draft. That specific, accepted trade-off
        // has its own dedicated tests in tests/api.test.ts; folding it into THIS success
        // metric would flag correct behaviour as a failure. Finding #1's retry-of-a-mid-
        // interview-turn is what the block below exercises instead.
        return { personIndex, outcome: "completed", resultId: result.data.resultId, turns, retries };
      }

      // Simulate the response getting lost on the way back and the client retrying with the
      // identical requestId — this is audit finding #1's exact failure mode, now exercised
      // under real concurrent load instead of in isolation.
      let effective = result;
      if (Math.random() < LOST_RESPONSE_RATE) {
        retries += 1;
        const retry = await callTurn(body);
        if (!retry.ok) return { personIndex, outcome: "failed", reason: `retry:${retry.status}`, turns, retries };
        turnLatencies.push(retry.ms);
        // Deep-equal, not a string comparison: `lastTurnResponse` round-trips through a
        // Postgres jsonb column, which does not preserve object key order (documented
        // Postgres behaviour), so two structurally identical responses can serialize to
        // different JSON text even when nothing is actually wrong.
        if (!deepEqual(retry.data, result.data)) {
          return { personIndex, outcome: "failed", reason: "retry-mismatch", turns, retries };
        }
        effective = retry;
      }
      const data = effective.data;
      if (data.status === "complete") {
        return { personIndex, outcome: "completed", resultId: data.resultId, turns, retries };
      }
      if (data.status === "fallback") {
        // Drain the same way the UI's tap form does: one tap per remaining question.
        let last: TurnResponse | null = null;
        for (const q of data.questions) {
          const tapBody: TurnRequest = { draftId, requestId: publicId(), tapped: answers[q.index] };
          const tapResult = await callTurn(tapBody);
          if (!tapResult.ok) return { personIndex, outcome: "failed", reason: `drain:${tapResult.status}`, turns, retries };
          turnLatencies.push(tapResult.ms);
          last = tapResult.data;
        }
        if (last?.status === "complete") {
          return { personIndex, outcome: "completed", resultId: last.resultId, turns, retries };
        }
        return { personIndex, outcome: "failed", reason: "drain-incomplete", turns, retries };
      }
      ask = data.ask;
    }
    return { personIndex, outcome: "failed", reason: "turn-limit-exceeded", turns: MAX_TURNS_PER_PERSON, retries };
  }

  function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[index];
  }

  it(
    `simulates ${PEOPLE} people completing the interview concurrently, with a ${Math.round(LOST_RESPONSE_RATE * 100)}% lost-response retry rate`,
    async () => {
      const turnLatencies: number[] = [];
      const wallClockStart = Date.now();

      const outcomes = await Promise.all(Array.from({ length: PEOPLE }, (_, i) => runPerson(i, turnLatencies)));

      const wallClockMs = Date.now() - wallClockStart;
      const completed = outcomes.filter((o) => o.outcome === "completed");
      const failed = outcomes.filter((o) => o.outcome === "failed") as Extract<PersonOutcome, { outcome: "failed" }>[];
      const totalRetries = outcomes.reduce((sum, o) => sum + o.retries, 0);
      const sortedLatencies = [...turnLatencies].sort((a, b) => a - b);

      const failureReasons = new Map<string, number>();
      for (const f of failed) failureReasons.set(f.reason, (failureReasons.get(f.reason) ?? 0) + 1);

      console.log(`
--- concurrent mock load test ---
people:            ${PEOPLE}
completed:         ${completed.length}
failed:            ${failed.length}${failed.length ? " (" + [...failureReasons].map(([r, n]) => `${r}: ${n}`).join(", ") + ")" : ""}
lost-response retries simulated: ${totalRetries}
wall clock:        ${wallClockMs}ms
turn latency (mocked model, includes DB): p50=${percentile(sortedLatencies, 0.5)}ms p90=${percentile(sortedLatencies, 0.9)}ms p99=${percentile(sortedLatencies, 0.99)}ms max=${sortedLatencies.at(-1) ?? 0}ms
----------------------------------`);

      // A 429 is the per-draft rate limiter (INTERVIEW_LIMITS.turnsPerMinute) correctly
      // doing its job against a burst — most often a person unlucky enough to draw several
      // simulated lost-response retries close together, which fire back-to-back with none of
      // the "thinking" pacing a real reply takes. That is capacity behaving as designed, not
      // a defect, so it is reported but not asserted to zero. Anything else — a crash, a
      // 5xx, a mismatched retry — means OUR code broke under concurrency and must be zero.
      const nonRateLimited = failed.filter((f) => !f.reason.endsWith(":429"));
      expect(nonRateLimited, `${nonRateLimited.length} people failed for a reason other than rate limiting: ${JSON.stringify(nonRateLimited.slice(0, 5))}`).toHaveLength(0);

      // THE invariant this whole test exists to check: exactly one response per completed
      // person, never zero, never two — this is audit findings #1 and #2 under real
      // concurrency, not just the isolated retry each has its own unit test for.
      const responseRows = await harness.db.select().from(responses);
      expect(responseRows).toHaveLength(completed.length);
      const emails = responseRows.map((r) => r.email);
      expect(new Set(emails).size).toBe(emails.length);

      const teamRows = await harness.db.select().from(teams);
      expect(teamRows).toHaveLength(completed.length);

      // Every completed person's draft was consumed — no leaked PII sitting around.
      const remainingDrafts = await harness.db.select().from(interviewDrafts);
      expect(remainingDrafts.length).toBeLessThanOrEqual(PEOPLE - completed.length);
    },
    10 * 60 * 1000,
  );
});
