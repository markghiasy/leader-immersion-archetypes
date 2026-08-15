import "./load-env";
import { clientQuestions, QUESTION_COUNT } from "@/lib/scoring";
import { publicId } from "@/lib/ids";

/**
 * CONCURRENT LOAD TEST AGAINST A LIVE DEPLOYMENT — real HTTP, real server, real database,
 * real Anthropic key. No mocking anywhere: this is the counterpart to
 * tests/load/concurrent-mock.test.ts, which proves OUR code is correct under concurrency
 * using a stand-in model and an in-process database. This script instead asks the question
 * that stand-in cannot answer: does the real deployed stack — Vercel's real instance count,
 * the real database connection, the real Anthropic key's real rate limit — hold up.
 *
 * DELIBERATELY NOT using a model to roleplay each person (scripts/synthetic-cohort.ts does
 * that, and answers a different question — "does a realistic person finish a real
 * conversation" — which needs a real roleplaying model and costs roughly 2x the API calls).
 * This script only needs the REAL SERVER's extraction to read a plausible reply correctly,
 * which a fixed, deterministic phrasing already does reliably (see replyChoosing below) —
 * so no model call happens on this script's side at all, only on the server's.
 *
 * SAFETY: this writes real rows into whatever database BASE_URL is backed by, and spends
 * real Anthropic API budget on that deployment's key. Every synthetic contact is tagged
 * `loadtest.<runTag>.<n>@example.com` / mobile `0400 900 0xx` specifically so these rows are
 * easy to find and exclude from any real count, distribution, or export — the same
 * convention scripts/synthetic-cohort.ts uses for its own (differently tagged) rows. Refuses
 * to run against a non-localhost BASE_URL unless CONFIRM_PRODUCTION=1 is set.
 *
 * Run — 100 people via the "uat" event entry point, matching how a real QR scan of
 * /q/uat behaves (the event slug rides in the /api/interview/start body, same as the page):
 *   CONFIRM_PRODUCTION=1 PEOPLE=100 BASE_URL=https://leader-immersion-archetype.aaronsansoni.com \
 *     EVENT_SLUG=uat npx tsx scripts/live-load-test.ts
 *
 * Tune with env vars:
 *   BASE_URL             default https://leader-immersion-archetype.aaronsansoni.com
 *   EVENT_SLUG           default "uat" — set to "" to omit event attribution entirely
 *   PEOPLE               default 20
 *   RAMP_MS              spread starts across this window; default 400 * PEOPLE (ms)
 *   THINK_MIN_MS/THINK_MAX_MS   pause between turns, default 3000 / 8000 — real human pacing
 *   MAX_TURNS             safety cap per person, default 45 (budget is 40 + drain taps)
 */

const BASE_URL = process.env.BASE_URL ?? "https://leader-immersion-archetype.aaronsansoni.com";
const EVENT_SLUG = process.env.EVENT_SLUG ?? "uat";
const PEOPLE = Number(process.env.PEOPLE ?? 20);
const RAMP_MS = Number(process.env.RAMP_MS ?? 400 * PEOPLE);
const THINK_MS = { min: Number(process.env.THINK_MIN_MS ?? 3000), max: Number(process.env.THINK_MAX_MS ?? 8000) };
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 45);
const RUN_TAG = Date.now().toString(36);

if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE_URL) && process.env.CONFIRM_PRODUCTION !== "1") {
  console.error(`Refusing to run against ${BASE_URL} without CONFIRM_PRODUCTION=1.`);
  console.error("This writes real rows and spends real API budget on that deployment. Set the env var if that's intended.");
  process.exit(1);
}

type Ask = { text: string; questionIndex: number; kind: string; options: string[]; progress: number; retry?: boolean };
type TurnResult =
  | { status: "continue"; ask: Ask }
  | { status: "complete"; resultId: string }
  | { status: "fallback"; remaining: number[]; questions: { index: number; text: string; options: string[] }[] };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function thinkTime(): Promise<void> {
  return delay(THINK_MS.min + Math.random() * (THINK_MS.max - THINK_MS.min));
}

/** Same trick used throughout this repo's test suite: embeds the option's own text, which a
 * real extraction call reads back reliably without needing a model to write the reply too. */
function replyChoosing(questionIndex: number, value: number): string {
  return `Honestly, ${clientQuestions[questionIndex].options[value]} — that's just how I work.`;
}

async function post<T>(path: string, body: unknown, attempt = 1): Promise<{ status: number; data: T | null; ms: number }> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - startedAt;
    const data = (await response.json().catch(() => null)) as T | null;
    return { status: response.status, data, ms };
  } catch (error) {
    // A real network call to a remote server can fail transiently in a way an in-process
    // call never does. One retry before this counts as a real failure.
    if (attempt < 2) {
      await delay(500);
      return post(path, body, attempt + 1);
    }
    console.warn(`  network error on ${path} (attempt ${attempt}): ${error instanceof Error ? error.message : error}`);
    return { status: 0, data: null, ms: Date.now() - startedAt };
  }
}

type PersonOutcome =
  | { personIndex: number; outcome: "completed"; resultId: string; turns: number }
  | { personIndex: number; outcome: "failed"; reason: string; turns: number };

async function runPerson(personIndex: number, turnLatencies: number[]): Promise<PersonOutcome> {
  // Staggers the start across RAMP_MS so PEOPLE people don't all hit /api/interview/start
  // in the same instant — a QR rush trickles in over the first few minutes, it doesn't
  // teleport in at once. Set RAMP_MS=0 to test the instant-burst case instead.
  await delay((RAMP_MS * personIndex) / Math.max(1, PEOPLE));

  const contact = {
    firstName: "LoadTest",
    lastName: `${RUN_TAG}-${personIndex}`,
    email: `loadtest.${RUN_TAG}.${personIndex}@example.com`,
    mobile: `0400 900 ${String(personIndex % 1000).padStart(3, "0")}`,
    company: null,
  };

  const startBody: Record<string, unknown> = { contact };
  if (EVENT_SLUG) startBody.event = EVENT_SLUG;

  const started = await post<{ draftId: string; ask: Ask }>("/api/interview/start", startBody);
  if (started.status !== 201 || !started.data) {
    return { personIndex, outcome: "failed", reason: `start:${started.status}`, turns: 0 };
  }
  turnLatencies.push(started.ms);

  const draftId = started.data.draftId;
  let ask = started.data.ask;
  const answers = Array.from({ length: QUESTION_COUNT }, () => Math.floor(Math.random() * 4));

  for (let turns = 1; turns <= MAX_TURNS; turns += 1) {
    await thinkTime();
    const qi = ask.questionIndex;
    const body = { draftId, requestId: publicId(), reply: replyChoosing(qi, answers[qi]) };
    const result = await post<TurnResult>("/api/interview/turn", body);
    if (result.status !== 200 || !result.data) {
      return { personIndex, outcome: "failed", reason: `turn:${result.status}`, turns };
    }
    turnLatencies.push(result.ms);

    if (result.data.status === "complete") {
      return { personIndex, outcome: "completed", resultId: result.data.resultId, turns };
    }
    if (result.data.status === "fallback") {
      let last: TurnResult | null = null;
      for (const q of result.data.questions) {
        await delay(300 + Math.random() * 500); // a tap is near-instant, unlike typing
        const tapResult = await post<TurnResult>("/api/interview/turn", { draftId, requestId: publicId(), tapped: answers[q.index] });
        if (tapResult.status !== 200 || !tapResult.data) {
          return { personIndex, outcome: "failed", reason: `drain:${tapResult.status}`, turns };
        }
        turnLatencies.push(tapResult.ms);
        last = tapResult.data;
      }
      if (last?.status === "complete") return { personIndex, outcome: "completed", resultId: last.resultId, turns };
      return { personIndex, outcome: "failed", reason: "drain-incomplete", turns };
    }
    ask = result.data.ask;
  }
  return { personIndex, outcome: "failed", reason: "turn-limit-exceeded", turns: MAX_TURNS };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function main() {
  console.log(`Live load test — ${PEOPLE} people against ${BASE_URL}${EVENT_SLUG ? ` (event=${EVENT_SLUG})` : ""}`);
  console.log(`Ramp: ${RAMP_MS}ms · think time: ${THINK_MS.min}-${THINK_MS.max}ms · run tag: ${RUN_TAG}`);
  console.log(`Synthetic contacts tagged loadtest.${RUN_TAG}.<n>@example.com — filter these out of any real count.\n`);

  const turnLatencies: number[] = [];
  const wallClockStart = Date.now();
  const outcomes = await Promise.all(Array.from({ length: PEOPLE }, (_, i) => runPerson(i, turnLatencies)));
  const wallClockMs = Date.now() - wallClockStart;

  const completed = outcomes.filter((o) => o.outcome === "completed");
  const failed = outcomes.filter((o) => o.outcome === "failed") as Extract<PersonOutcome, { outcome: "failed" }>[];
  const failureReasons = new Map<string, number>();
  for (const f of failed) failureReasons.set(f.reason, (failureReasons.get(f.reason) ?? 0) + 1);
  const sorted = [...turnLatencies].sort((a, b) => a - b);

  console.log(`
--- live load test: ${PEOPLE} people ---
completed:   ${completed.length}
failed:      ${failed.length}${failed.length ? " (" + [...failureReasons].map(([r, n]) => `${r}: ${n}`).join(", ") + ")" : ""}
wall clock:  ${(wallClockMs / 1000).toFixed(1)}s
request latency (real network + real model, includes /start, /turn, drain taps):
  p50=${percentile(sorted, 0.5)}ms  p90=${percentile(sorted, 0.9)}ms  p99=${percentile(sorted, 0.99)}ms  max=${sorted.at(-1) ?? 0}ms
------------------------------------------
Cleanup reminder: rows tagged loadtest.${RUN_TAG}.*@example.com now exist in the real database.
`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
