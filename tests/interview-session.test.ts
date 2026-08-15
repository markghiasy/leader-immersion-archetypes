import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, teardownTestDb } from "./helpers/test-db";
import { interviewDrafts, responses, teams } from "@/lib/schema";
import { seedEvent } from "@/lib/queries";
import { resetRateLimits } from "@/lib/rate-limit";
import { clientQuestions, optionIndexById, questions, QUESTION_COUNT, score, testVectors } from "@/lib/scoring";
import {
  INTERVIEW_LIMITS,
  type AgentTurn,
  type StartRequest,
  type StartResponse,
  type TurnRequest,
  type TurnResponse,
} from "@/lib/interview/contract";
import { getDraft } from "@/lib/interview/store";
import { publicId } from "@/lib/ids";
import type { Certainty, ExtractionWithQuote } from "@/lib/interview/extractor";
// The two endpoints under test. `vi.mock` below is hoisted above every import in this file,
// so these already resolve to the mocked extractor and phrasing modules.
import { POST as startRoute } from "@/app/api/interview/start/route";
import { POST as turnRoute } from "@/app/api/interview/turn/route";

/**
 * THE TURN ORCHESTRATION, tested end to end through its two endpoints.
 *
 * tests/interview.test.ts already proves the controller is a sound state machine in
 * isolation. This file tests the part the controller cannot: that the API route, the
 * persisted draft, the model calls and the canonical write are wired together such that a
 * conversation lands the same archetype the tap form would, exactly once.
 *
 * The model is MOCKED throughout. Not for speed — for determinism. The whole risk of a
 * conversational instrument is that the same answers can produce a different result on a
 * different day; a test that calls a real model cannot tell that failure apart from
 * sampling noise, so it would be the one test least able to catch the one bug that matters.
 *
 * `importOriginal` is spread rather than a bare factory so the pure exports (narrowingAsk,
 * the certainty table, the configs) stay real — only the two functions that reach the
 * network are replaced.
 */

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

let harness: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  harness = await createTestDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(async () => {
  await resetTestDb(harness.db);
  // resetTestDb truncates the three tables the form journey uses. Drafts are a separate,
  // disposable tier, so they are cleared here rather than there — a leaked draft would
  // make "exactly one draft exists" pass or fail for the wrong reason.
  await harness.db.delete(interviewDrafts);

  models.extract.mockReset();
  models.askFor.mockReset();
  // The phrasing layer's only contract is that the question survives verbatim, so the
  // stand-in satisfies exactly that and nothing more.
  models.askFor.mockImplementation(async (questionText) => ({
    text: `Right — ${questionText}`,
    verbatimPreserved: true,
  }));
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The first replay vector as option indexes: the same answer set tests/api.test.ts submits. */
const VECTOR_ANSWERS = questions.map((question, qi) => optionIndexById(qi, testVectors[0].answers[question.id]));

/**
 * Mirrors the extractor's private certainty→confidence table. Duplicated deliberately: the
 * point of these tests is that `inferred` lands below the controller's threshold and
 * `explicit` lands above it, so the numbers need to be visible where the expectation is.
 */
const CONFIDENCE: Record<Certainty, number> = { explicit: 0.95, implied: 0.82, inferred: 0.55 };

function contact(overrides: Partial<StartRequest["contact"]> = {}): StartRequest["contact"] {
  return {
    firstName: "Alex",
    lastName: "Nguyen",
    email: "alex@example.com",
    mobile: "0412 345 678",
    company: "Northwind",
    ...overrides,
  };
}

/** What a person plausibly types when they mean option `value`, with the quote inside it. */
function replyChoosing(questionIndex: number, value: number): string {
  return `Honestly, ${clientQuestions[questionIndex].options[value]} — that's just how I work.`;
}

/** One extraction, shaped exactly as the real extractor returns it. */
function heard(questionIndex: number, value: number, certainty: Certainty): ExtractionWithQuote[] {
  return [
    {
      questionIndex,
      value,
      confidence: CONFIDENCE[certainty],
      certainty,
      quote: clientQuestions[questionIndex].options[value],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Driving the endpoints
 * ------------------------------------------------------------------ */

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
    body: JSON.stringify(body),
  });
}

async function start(body: Partial<StartRequest> = {}): Promise<StartResponse> {
  const response = await startRoute(request("/api/interview/start", { contact: contact(), ...body }));
  const json = await response.json();
  expect(response.status, `start failed: ${JSON.stringify(json)}`).toBe(201);
  return json as StartResponse;
}

async function turn(body: Omit<TurnRequest, "requestId"> & { requestId?: string }): Promise<TurnResponse> {
  // A fresh id per call by default, so tests that don't care about retries don't have to
  // invent one — see the requestId field comment on TurnRequest for what a real client does.
  const response = await turnRoute(request("/api/interview/turn", { requestId: publicId(), ...body }));
  const json = await response.json();
  expect(response.status, `turn failed: ${JSON.stringify(json)}`).toBe(200);
  return json as TurnResponse;
}

/**
 * Drafts are read through the store rather than off the table. The column keeps -1 for an
 * unsettled slot where the contract says null (see lib/interview/store.ts), and a test that
 * asserted on the sentinel would be testing the storage trick instead of the behaviour.
 */
async function readDraft(draftId: string) {
  const draft = await getDraft(draftId);
  return draft;
}

function settledIndexes(answers: (number | null)[]): number[] {
  return answers.map((a, i) => (a === null ? -1 : i)).filter((i) => i >= 0);
}

/**
 * Answer whatever the agent asks, from `answers`, at `certainty`, until it completes.
 * Returns every question index in the order it was asked plus the resulting scorecard id.
 */
async function completeInterview(
  draftId: string,
  opening: AgentTurn,
  answers: number[] = VECTOR_ANSWERS,
  certainty: Certainty = "explicit",
): Promise<{ resultId: string; asked: number[]; progress: number[] }> {
  let ask = opening;
  const asked: number[] = [];
  const progress: number[] = [opening.progress];

  // Bounded: a loop that cannot terminate must fail the test, not hang the suite.
  for (let n = 0; n <= QUESTION_COUNT; n += 1) {
    expect(ask.kind).toBe("ask");
    const qi = ask.questionIndex;
    asked.push(qi);

    models.extract.mockResolvedValueOnce(heard(qi, answers[qi], certainty));
    const result = await turn({ draftId, reply: replyChoosing(qi, answers[qi]) });

    if (result.status === "complete") return { resultId: result.resultId, asked, progress };
    expect(result.status).toBe("continue");
    if (result.status !== "continue") throw new Error("unreachable");
    ask = result.ask;
    progress.push(ask.progress);
  }
  throw new Error(`interview did not complete within ${QUESTION_COUNT + 1} direct answers`);
}

/* ------------------------------------------------------------------ *
 * The happy path
 * ------------------------------------------------------------------ */

describe("a full interview", () => {
  it("settles all 25 from direct answers and writes the completion exactly once", async () => {
    await seedEvent("melbourne-aug", "Melbourne — August");

    const { draftId, ask } = await start({ event: "melbourne-aug" });
    expect(draftId).toMatch(/^[A-Za-z0-9_-]{14}$/);

    // One draft, created up front: a 16-20 minute interview cannot hold state in the client.
    expect(await harness.db.select().from(interviewDrafts)).toHaveLength(1);
    expect(await readDraft(draftId)).not.toBeNull();

    const { resultId, asked, progress } = await completeInterview(draftId, ask);

    // 25 questions, each asked once, no re-asks — every answer was taken first time.
    expect(asked).toHaveLength(QUESTION_COUNT);
    expect(new Set(asked).size).toBe(QUESTION_COUNT);
    expect(progress.every((p) => p >= 0 && p <= 1)).toBe(true);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);

    // Exactly one response and one team — the canonical write still happens ONCE, at the
    // end, in the same transaction as the form's. Per-turn drafts must not leak into it.
    const rows = await harness.db.select().from(responses);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(resultId);
    expect(rows[0].answers).toEqual(VECTOR_ANSWERS);
    expect(rows[0].eventSlug).toBe("melbourne-aug");
    expect(rows[0].firstName).toBe("Alex");
    expect(rows[0].intakeMode).toBe("interview");

    expect(await harness.db.select().from(teams)).toHaveLength(1);
    const [team] = await harness.db.select().from(teams).where(eq(teams.ownerResponseId, resultId));
    expect(team.slug).toMatch(/^[A-Za-z0-9_-]{14}$/);
  });

  it("leaves no draft behind once the response is written", async () => {
    const { draftId, ask } = await start();
    await completeInterview(draftId, ask);

    // The draft is a disposable tier holding a full contact record and a transcript. Once
    // the canonical row exists it is duplicate PII with no reader, so deleteDraft must run.
    expect(await readDraft(draftId)).toBeNull();
    expect(await harness.db.select().from(interviewDrafts)).toHaveLength(0);
  });

  it("asks the schema's question verbatim and always offers the four options", async () => {
    const { draftId, ask } = await start();

    let current = ask;
    for (let n = 0; n < 5; n += 1) {
      const qi = current.questionIndex;
      // Fixed stimulus: the model writes the sentence before the question, never the question.
      expect(current.text).toContain(questions[qi].text);
      // The tap form is the floor — the escape hatch renders without another round trip.
      expect(current.options).toEqual(clientQuestions[qi].options);

      models.extract.mockResolvedValueOnce(heard(qi, VECTOR_ANSWERS[qi], "explicit"));
      const result = await turn({ draftId, reply: replyChoosing(qi, VECTOR_ANSWERS[qi]) });
      if (result.status !== "continue") throw new Error(`unexpected ${result.status}`);
      current = result.ask;
    }
  });
});

/* ------------------------------------------------------------------ *
 * Retry safety — audit finding #1
 *
 * A turn is atomic, but the RESPONSE can still be lost after the write commits (a radio
 * drop on venue wifi is the documented cause). The client's retry then resends the same
 * requestId. Before this fix, the server had already advanced past the question that
 * request answered, and a same-content resend would silently answer the NEW question with
 * the OLD reply instead.
 * ------------------------------------------------------------------ */

describe("retrying a turn whose response was lost", () => {
  it("replays the exact prior response instead of applying the reply to the next question", async () => {
    const { draftId, ask } = await start();
    const q0 = ask.questionIndex;

    models.extract.mockResolvedValueOnce(heard(q0, VECTOR_ANSWERS[q0], "explicit"));
    const requestId = publicId();
    const first = await turn({ draftId, requestId, reply: replyChoosing(q0, VECTOR_ANSWERS[q0]) });
    if (first.status !== "continue") throw new Error(`unexpected ${first.status}`);

    // The client never saw `first` (its connection dropped) and retries with the identical
    // requestId and reply. Extraction must not run again — a real retry is answered from
    // the cache, not reprocessed — and the response must be byte-identical to the first.
    models.extract.mockRejectedValue(new Error("a retried turn must not be reprocessed"));
    const retry = await turn({ draftId, requestId, reply: replyChoosing(q0, VECTOR_ANSWERS[q0]) });

    expect(retry).toEqual(first);
    expect(retry.status).toBe("continue");
    if (retry.status !== "continue") throw new Error("unreachable");
    expect(retry.ask.questionIndex).toBe(first.ask.questionIndex);

    // Only q0 is settled — the retry did not advance a second question or overwrite q0's
    // answer with whatever it would have (wrongly) been read as against question 1.
    const draft = await readDraft(draftId);
    expect(settledIndexes(draft!.answers)).toEqual([q0]);
  });

  it("still processes a genuinely new turn that happens to repeat the same reply text", async () => {
    // The exact scenario that a content-only fingerprint (reply/tapped alone, no requestId)
    // cannot tell apart from a retry: someone re-asked the same question after an unreadable
    // answer who then types the same unhelpful thing again. Each attempt is a fresh, real
    // submission with its own requestId, so both must be processed, not just the first.
    const { draftId, ask } = await start();
    const q0 = ask.questionIndex;

    models.extract.mockResolvedValueOnce([]); // nothing heard — re-asks the same question
    const missed = await turn({ draftId, reply: "Hmm. Hard to say." });
    if (missed.status !== "continue") throw new Error(`unexpected ${missed.status}`);
    expect(missed.ask.questionIndex).toBe(q0);
    expect(missed.ask.retry).toBe(true);

    models.extract.mockResolvedValueOnce([]); // still nothing — a genuine second miss
    const missedAgain = await turn({ draftId, reply: "Hmm. Hard to say." });
    if (missedAgain.status !== "continue") throw new Error(`unexpected ${missedAgain.status}`);
    expect(missedAgain.ask.questionIndex).toBe(q0);
    expect(models.extract).toHaveBeenCalledTimes(2);

    // The opening turn already counts as 1; two re-asks after it make 3.
    const draft = await readDraft(draftId);
    expect(draft!.turn).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * The instrument guarantee
 *
 * The one thing that would invalidate the 499-response baseline is the interview quietly
 * scoring differently from the form. It is asserted on its own rather than folded into the
 * happy path, because it is the test that must never be deleted for being redundant.
 * ------------------------------------------------------------------ */

describe("the interview cannot produce a different archetype than the form", () => {
  it("scores identically to score() over the same answers", async () => {
    const { draftId, ask } = await start();
    const { resultId } = await completeInterview(draftId, ask);

    const [row] = await harness.db.select().from(responses).where(eq(responses.id, resultId));
    const expected = score(VECTOR_ANSWERS);

    expect(row.answers).toEqual(VECTOR_ANSWERS);
    expect(row.totals).toEqual(expected.totals);
    expect(row.profile).toBe(expected.profile);
    // And the same archetype the frozen replay vector pins for the tap form.
    expect(row.profile).toBe(testVectors[0].expected_archetype);
  });

  it("scores a second, different answer set identically too", async () => {
    const other = questions.map((question, qi) => optionIndexById(qi, testVectors[2].answers[question.id]));
    const { draftId, ask } = await start({ contact: contact({ email: "jo@example.com" }) });
    const { resultId } = await completeInterview(draftId, ask, other);

    const [row] = await harness.db.select().from(responses).where(eq(responses.id, resultId));
    expect(row.answers).toEqual(other);
    expect(row.profile).toBe(score(other).profile);
    expect(row.profile).toBe(testVectors[2].expected_archetype);
  });
});

/* ------------------------------------------------------------------ *
 * Taps
 * ------------------------------------------------------------------ */

describe("tapping an option", () => {
  it("is taken as the answer outright and never sent to the model", async () => {
    const { draftId, ask } = await start();
    const qi = ask.questionIndex;

    // If extraction is reached at all, this rejects and the turn fails loudly.
    models.extract.mockRejectedValue(new Error("a tapped answer must never reach extraction"));

    const result = await turn({ draftId, tapped: 2 });
    expect(result.status).toBe("continue");
    expect(models.extract).not.toHaveBeenCalled();

    const draft = await readDraft(draftId);
    expect(draft!.answers[qi]).toBe(2);

    // A tap is unambiguous, so it settles immediately rather than proposing.
    if (result.status !== "continue") throw new Error("unreachable");
    expect(result.ask.questionIndex).not.toBe(qi);
    expect(result.ask.kind).toBe("ask");
  });

  it("records provenance with no quote, because there were no words to quote", async () => {
    const { draftId, ask } = await start();
    const qi = ask.questionIndex;
    await turn({ draftId, tapped: 3 });

    const draft = await readDraft(draftId);
    const record = draft!.provenance.find((p) => p.questionIndex === qi);
    expect(record).toMatchObject({ questionIndex: qi, value: 3, certainty: "tapped", quote: "" });
  });
});

/* ------------------------------------------------------------------ *
 * When the model hears nothing usable
 * ------------------------------------------------------------------ */

describe("an utterance that answers nothing", () => {
  it("re-asks the same question rather than moving on", async () => {
    const { draftId, ask } = await start();
    const qi = ask.questionIndex;
    const progressBefore = ask.progress;

    models.extract.mockResolvedValue([]);
    const result = await turn({ draftId, reply: "Sorry, could you repeat that?" });

    expect(result.status).toBe("continue");
    if (result.status !== "continue") throw new Error("unreachable");
    // Abandoning the question the person is mid-way through answering reads as not
    // listening, and the leverage ordering would happily pick a different one.
    expect(result.ask.questionIndex).toBe(qi);
    expect(result.ask.kind).toBe("ask");
    expect(result.ask.progress).toBe(progressBefore);
  });

  it("settles nothing, so the count does not advance", async () => {
    const { draftId } = await start();
    models.extract.mockResolvedValue([]);

    await turn({ draftId, reply: "It really depends on the day." });
    await turn({ draftId, reply: "Hard to say, honestly." });

    const draft = await readDraft(draftId);
    expect(draft!.answers).toHaveLength(QUESTION_COUNT);
    expect(settledIndexes(draft!.answers)).toEqual([]);
    expect(draft!.provenance).toEqual([]);
  });

  it("asks the model about the open question only — one question, one answer", async () => {
    const { draftId, ask } = await start();
    models.extract.mockResolvedValue([]);
    await turn({ draftId, reply: "Not sure what you mean." });

    // Mining several answers out of one narrative measured 60.6% against 97.9% for direct
    // answers, and is not built. Handing the model more than the open question invites it.
    expect(models.extract).toHaveBeenCalledTimes(1);
    expect(models.extract.mock.calls[0][0]).toEqual([ask.questionIndex]);
    expect(models.extract.mock.calls[0][1]).toBe("Not sure what you mean.");
  });
});

/* ------------------------------------------------------------------ *
 * Low confidence
 * ------------------------------------------------------------------ */

describe("an extraction below the confidence threshold", () => {
  it("asks the person to confirm instead of keeping the answer", async () => {
    const { draftId, ask } = await start();
    const qi = ask.questionIndex;

    models.extract.mockResolvedValue(heard(qi, 1, "inferred"));
    const result = await turn({ draftId, reply: "I suppose I lean that way, sort of." });

    expect(result.status).toBe("continue");
    if (result.status !== "continue") throw new Error("unreachable");
    expect(result.ask.kind).toBe("confirm");
    expect(result.ask.questionIndex).toBe(qi);
    // The narrowing turn still shows all four, so the person can correct it in one tap.
    expect(result.ask.options).toEqual(clientQuestions[qi].options);

    // One wrong answer in 25 changes the archetype 15.4% of the time, so nothing is kept
    // yet — not the answer, and not a provenance record implying one was settled.
    const draft = await readDraft(draftId);
    expect(draft!.answers[qi]).toBeNull();
    expect(draft!.provenance.some((p) => p.questionIndex === qi)).toBe(false);
  });

  it("keeps the person's answer to the narrowing question, not the model's guess", async () => {
    const { draftId, ask } = await start();
    const qi = ask.questionIndex;

    models.extract.mockResolvedValue(heard(qi, 1, "inferred"));
    await turn({ draftId, reply: "Sort of both, really." });

    const result = await turn({ draftId, tapped: 3 });
    expect(result.status).toBe("continue");

    const draft = await readDraft(draftId);
    expect(draft!.answers[qi]).toBe(3);
    const record = draft!.provenance.find((p) => p.questionIndex === qi);
    // The value must be the person's 3, never the model's 1. The certainty must name a
    // person as the source — a tap is recorded as "tapped", a typed adjudication as
    // "confirmed" — and must never be one of the extractor's own certainties.
    expect(record?.value).toBe(3);
    expect(["tapped", "confirmed"]).toContain(record?.certainty);
  });

  it("keeps an extraction at or above the threshold without a narrowing turn", async () => {
    const { draftId, ask } = await start();
    const qi = ask.questionIndex;

    models.extract.mockResolvedValue(heard(qi, 2, "implied"));
    const result = await turn({ draftId, reply: replyChoosing(qi, 2) });

    if (result.status !== "continue") throw new Error("unreachable");
    expect(result.ask.kind).toBe("ask");
    expect(result.ask.questionIndex).not.toBe(qi);
    expect((await readDraft(draftId))!.answers[qi]).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * The turn budget
 * ------------------------------------------------------------------ */

describe("the turn budget", () => {
  it("hands the unsettled questions to the tap form rather than guessing", async () => {
    const { draftId, ask } = await start();

    // Settle three by tapping first, so `remaining` has to be the unsettled set and not
    // simply "all 25" — the fallback must not make the person redo what they have answered.
    const tapped: number[] = [];
    let current = ask;
    for (let n = 0; n < 3; n += 1) {
      tapped.push(current.questionIndex);
      const result = await turn({ draftId, tapped: 1 });
      if (result.status !== "continue") throw new Error(`unexpected ${result.status}`);
      current = result.ask;
    }

    models.extract.mockResolvedValue([]);
    let result: TurnResponse | null = null;
    let turns = 0;
    while (turns < INTERVIEW_LIMITS.maxTurns + 5) {
      // The per-draft limit is 30 turns per minute and the budget is 40, so a fast talker
      // (and this test) hits the limiter before the budget. Cleared each turn so the thing
      // under test is the budget. See the note in the handover: those two numbers conflict.
      resetRateLimits();
      turns += 1;
      result = await turn({ draftId, reply: "Hmm. Hard to say." });
      if (result.status !== "continue") break;
    }

    expect(result!.status).toBe("fallback");
    if (!result || result.status !== "fallback") throw new Error("unreachable");
    expect(turns).toBeLessThanOrEqual(INTERVIEW_LIMITS.maxTurns);

    const expectedRemaining = Array.from({ length: QUESTION_COUNT }, (_, i) => i).filter((i) => !tapped.includes(i));
    expect([...result.remaining].sort((a, b) => a - b)).toEqual(expectedRemaining);

    // The form needs everything it takes to render, in one payload: nothing settled, and
    // the schema's own wording so the fallback is the same instrument as the interview.
    expect(result.questions.map((q) => q.index)).toEqual(result.remaining);
    for (const q of result.questions) {
      expect(q.text).toBe(questions[q.index].text);
      expect(q.options).toEqual(clientQuestions[q.index].options);
    }
  });

  it("writes no response until the fallback form is submitted", async () => {
    const { draftId } = await start();
    models.extract.mockResolvedValue([]);

    let result: TurnResponse | null = null;
    for (let n = 0; n < INTERVIEW_LIMITS.maxTurns + 5; n += 1) {
      resetRateLimits();
      result = await turn({ draftId, reply: "No idea, really." });
      if (result.status !== "continue") break;
    }

    expect(result!.status).toBe("fallback");
    // An abandoned interview writes nothing at all, exactly as an abandoned form does.
    expect(await harness.db.select().from(responses)).toHaveLength(0);
    expect(await harness.db.select().from(teams)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

describe("provenance", () => {
  it("records why every settled answer is what it is", async () => {
    const { draftId, ask } = await start();

    // A realistic mix: some typed and extracted, some tapped out of the conversation.
    const expected = new Map<number, { value: number; certainty: string; quote: string }>();
    let current = ask;
    for (let n = 0; n < 8; n += 1) {
      const qi = current.questionIndex;
      const value = VECTOR_ANSWERS[qi];
      let result: TurnResponse;

      if (n % 3 === 0) {
        expected.set(qi, { value: 3, certainty: "tapped", quote: "" });
        result = await turn({ draftId, tapped: 3 });
      } else {
        const certainty: Certainty = n % 2 === 0 ? "implied" : "explicit";
        expected.set(qi, { value, certainty, quote: clientQuestions[qi].options[value] });
        models.extract.mockResolvedValueOnce(heard(qi, value, certainty));
        result = await turn({ draftId, reply: replyChoosing(qi, value) });
      }

      if (result.status !== "continue") throw new Error(`unexpected ${result.status}`);
      current = result.ask;
    }

    const draft = await readDraft(draftId);
    const settled = settledIndexes(draft!.answers);
    expect(settled).toEqual([...expected.keys()].sort((a, b) => a - b));

    // Every settled answer has exactly one record, and no record exists for anything unsettled.
    expect(draft!.provenance).toHaveLength(settled.length);
    expect(draft!.provenance.map((p) => p.questionIndex).sort((a, b) => a - b)).toEqual(settled);

    for (const record of draft!.provenance) {
      const want = expected.get(record.questionIndex)!;
      expect(record.value).toBe(want.value);
      expect(record.value).toBe(draft!.answers[record.questionIndex]);
      expect(record.certainty).toBe(want.certainty);
      expect(record.quote).toBe(want.quote);
      // The turn number is what makes this an audit trail rather than a summary.
      expect(record.turn).toBeGreaterThan(0);
    }
  });

  it("quotes the person's own words, verbatim from what they said", async () => {
    const { draftId, ask } = await start();
    const qi = ask.questionIndex;
    const reply = replyChoosing(qi, VECTOR_ANSWERS[qi]);

    models.extract.mockResolvedValueOnce(heard(qi, VECTOR_ANSWERS[qi], "explicit"));
    await turn({ draftId, reply });

    const draft = await readDraft(draftId);
    const record = draft!.provenance.find((p) => p.questionIndex === qi)!;
    expect(record.quote).not.toBe("");
    expect(reply).toContain(record.quote);
  });

  it("keeps the transcript in order, both sides of every exchange", async () => {
    const { draftId, ask } = await start();
    const qi = ask.questionIndex;
    const reply = replyChoosing(qi, VECTOR_ANSWERS[qi]);

    models.extract.mockResolvedValueOnce(heard(qi, VECTOR_ANSWERS[qi], "explicit"));
    await turn({ draftId, reply });

    const draft = await readDraft(draftId);
    expect(draft!.transcript.length).toBeGreaterThanOrEqual(2);
    expect(draft!.transcript[0]).toMatchObject({ role: "agent", questionIndex: qi, kind: "ask" });
    expect(draft!.transcript[1]).toMatchObject({ role: "person", text: reply });
  });
});

describe("the scorecard email on completion", () => {
  /**
   * The address is captured before the first question, so the scorecard is sent unprompted
   * rather than waiting for someone to ask. The rule that matters is what happens when that
   * send fails: the response and team are already committed, and a mail outage must cost an
   * email, never somebody's result.
   */
  it("does not cost anyone their scorecard when the mail provider fails", async () => {
    const email = await import("@/lib/email");
    const env = await import("@/lib/env");
    const enabled = vi.spyOn(env, "emailEnabled").mockReturnValue(true);
    const send = vi.spyOn(email, "sendScorecardEmail").mockRejectedValue(new Error("resend is down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { draftId, ask } = await start({});
      const { resultId } = await completeInterview(draftId, ask);

      // The completion stands, unchanged, despite the send throwing.
      expect(resultId).toMatch(/^[A-Za-z0-9_-]{14}$/);
      expect(await harness.db.select().from(responses)).toHaveLength(1);
      expect(await harness.db.select().from(teams)).toHaveLength(1);
      expect(await harness.db.select().from(interviewDrafts)).toHaveLength(0);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      enabled.mockRestore();
      send.mockRestore();
      logged.mockRestore();
    }
  });

  it("stays dormant while RESEND_API_KEY is unset", async () => {
    const email = await import("@/lib/email");
    const send = vi.spyOn(email, "sendScorecardEmail").mockResolvedValue(undefined);

    try {
      const { draftId, ask } = await start({});
      const { resultId } = await completeInterview(draftId, ask);

      expect(resultId).toMatch(/^[A-Za-z0-9_-]{14}$/);
      // emailEnabled() is false with no key configured, so nothing is attempted at all.
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });
});
