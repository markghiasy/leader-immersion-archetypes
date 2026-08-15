/**
 * TURN ORCHESTRATION — the glue between the controller, the model and the database.
 *
 * There is no interview logic in this file, and there should never be any. The controller
 * decides what to ask and when to stop, the extractor decides what was heard, phrasing
 * writes the sentence, the store persists, `score()` scores. This module's whole job is to
 * run those in the right order, once per HTTP request, and to make sure a turn that fails
 * halfway leaves nothing behind.
 *
 * Three decisions carry the design:
 *
 *   1. THE CONTROLLER IS REBUILT FROM THE DRAFT, NEVER SERIALISED. It is pure, so replaying
 *      the settled answers reproduces it exactly — and a state machine that only ever exists
 *      for the length of one request cannot drift from the row that outlives it.
 *   2. EXTRACTION SEES ONE QUESTION: the one the person was just asked. Mining several
 *      answers out of one narrative measured 60.6% against 97.9% for direct answers, so the
 *      open set is never handed over, however tempting the token saving.
 *   3. A TURN IS ATOMIC. Everything is computed first and written once, at the end. A turn
 *      that throws did not happen, and the client re-sending the same reply resumes exactly
 *      where it was — which is why nothing in here is written speculatively.
 */
import {
  INTERVIEW_LIMITS,
  type AgentTurn,
  type AnswerProvenance,
  type IntakeMode,
  type InterviewDraft,
  type StartRequest,
  type StartResponse,
  type TranscriptTurn,
  type TurnRequest,
  type TurnResponse,
} from "./contract";
import {
  applyConfirmation,
  applyExtractions,
  commitMove,
  createInterview,
  nextMove,
  type InterviewConfig,
  type InterviewState,
  type Move,
} from "./controller";
import { extract } from "./extractor";
import { askFor, narrowingAsk, reAskFor } from "./phrasing";
import { createDraft, getDraft, saveDraft, type DraftPatch } from "./store";
import { createInterviewCompletion, knownEventSlugs, teamIdBySlug } from "@/lib/queries";
import { clientQuestions, score, QUESTION_COUNT } from "@/lib/scoring";

/**
 * The bar a narrowing answer must clear to settle a slot. Same as the controller's, on
 * purpose: a narrowing turn that still cannot be read confidently is not evidence, and
 * contract rule 4 says an uncertain answer is never kept.
 */
const CONFIRM_THRESHOLD = 0.75;

/**
 * What the person reads immediately before typing their first answer — the highest-leverage
 * place to set the expectation, and the reason the first live tests failed: nobody had told
 * the tester what a usable answer looks like, so they wrote "with enthusiasm".
 *
 * Fixed text, deliberately not generated. This is the contract with the person: it must not
 * drift between runs, and a model must never be able to paraphrase it into promising less.
 * The first question follows it verbatim, as on every other turn.
 */
const OPENING_FRAME =
  "I'll ask you 25 questions about how you lead, one at a time. Answer in a sentence or " +
  "two — the more specific you are, the sharper your scorecard. If I need more, I'll say " +
  "so and show you some options to pick from.";

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/**
 * The interview as it is actually served.
 *
 * `sequential` rather than `leverage`, for a reason that is about this file specifically:
 * leverage ordering draws from the seeded RNG on every ranking, and this module rebuilds the
 * controller from stored answers on each request rather than carrying it across turns. The
 * rebuild replays a different number of draws than the original run, so the same draft could
 * be asked a different question on a retry than it was on the first attempt. Sequential is
 * deterministic under replay, which is the property a resumable interview needs — and it is
 * the control arm the simulations were measured against, so it is not a guess.
 *
 * `maxTurns` comes from the contract, not the controller's default: the ceiling is a
 * product decision about how long somebody will stay in a conversation, and it belongs
 * beside the other API limits.
 */
const SESSION_CONFIG: Partial<InterviewConfig> = {
  ordering: "sequential",
  maxTurns: INTERVIEW_LIMITS.maxTurns,
};

/**
 * Errors this module raises that are NOT transient. The route matches on `code` to decide
 * whether the client should try again; anything else that escapes is treated as a blip,
 * which is the right default because it usually is one.
 */
export class InterviewError extends Error {
  constructor(
    readonly code: "draft_not_found" | "draft_expired",
    message: string,
  ) {
    super(message);
    this.name = "InterviewError";
  }
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

export async function startInterview(input: StartRequest): Promise<StartResponse> {
  // Same rule as /api/submit: an unrecognised event slug is stored as null rather than
  // rejected, because a mistyped QR code should still let somebody take the quiz.
  const eventSlug = input.event && (await knownEventSlugs()).has(input.event) ? input.event : null;
  // The invite slug is kept unresolved until completion — see the note on `interview_drafts`
  // in lib/schema.ts. A draft must never hold a foreign key into the permanent data.
  const teamSlug = input.teamSlug ?? null;

  let state = createInterview(SESSION_CONFIG);
  const move = nextMove(state);
  if (move.kind !== "ask") {
    // Unreachable: a fresh interview has 25 unfilled slots and a spent budget of zero.
    throw new Error(`A new interview opened with a ${move.kind} move`);
  }

  // Phrase before writing anything. A phrasing failure then costs nobody a draft row holding
  // their name, email and mobile — and the whole point of the draft tier is that an
  // abandoned interview leaves as little PII behind as possible.
  const text = `${OPENING_FRAME}\n\n${move.text}`;
  state = commitMove(state, move);

  const draft = await createDraft({ contact: input.contact, eventSlug, teamSlug });
  const transcript: TranscriptTurn[] = [
    { role: "agent", text, questionIndex: move.questionIndex, kind: "ask", at: nowIso() },
  ];

  // A second write, because `createDraft` opens an empty draft and the opening turn belongs
  // in the transcript like every other. Two statements at start only; every turn after this
  // is a single update.
  await persist(draft.id, { answers: answersOf(state), transcript, provenance: [], turn: state.turn });

  return { draftId: draft.id, ask: agentTurn(text, move.questionIndex, "ask", move.options, state) };
}

/* ------------------------------------------------------------------ *
 * Turn
 * ------------------------------------------------------------------ */

export async function takeTurn(input: TurnRequest): Promise<TurnResponse> {
  const draft = await getDraft(input.draftId);
  if (!draft) {
    // The store cannot tell "never existed" from "expired" from "already completed", and
    // neither can the person: there is nothing to resume either way.
    throw new InterviewError("draft_not_found", "No interview is in progress for that id.");
  }

  const state = rehydrate(draft);
  const pending = nextMove(state);

  // Every question is settled but the draft is still here, so a previous turn wrote the
  // answers and then failed to write the response. Finish it rather than asking anything —
  // this is the retry path that makes the save-then-complete order in `finish` worth having.
  if (pending.kind === "complete") {
    return finish(draft, pending.answers, draft.transcript, draft.provenance, state);
  }

  // The budget is spent. The form is the floor, and from here the remaining questions are
  // tapped, not talked through.
  if (pending.kind === "fallback") {
    return drain(draft, state, pending.remaining, input);
  }

  return converse(draft, state, pending, input);
}

/**
 * One conversational turn: interpret what the person said about the question they were
 * actually shown, then issue whatever the controller wants next.
 */
async function converse(
  draft: InterviewDraft,
  state: InterviewState,
  pending: Extract<Move, { kind: "ask" | "confirm" }>,
  input: TurnRequest,
): Promise<TurnResponse> {
  const transcript = [...draft.transcript];
  const provenance = [...draft.provenance];

  // What the person was looking at when they replied, which is not necessarily what the
  // controller would choose now: the transcript is authoritative for interpreting an answer
  // because it is the question they actually saw.
  const shown = lastAsked(draft.transcript) ?? { questionIndex: pending.questionIndex, kind: pending.kind };
  const questionIndex = shown.questionIndex;
  const question = clientQuestions[questionIndex];

  let next = state;
  let lastReply: string;
  // Set when a typed reply could not be read at all. The re-ask must say so — an identical
  // question preceded by "noted" reads as a broken loop, which is exactly how it failed in
  // the first live test.
  let missed = false;

  if (input.tapped !== undefined) {
    // A tap is a statement, not evidence to be interpreted. It never goes near the extractor
    // — there is nothing for a model to add to somebody pointing at the answer they mean.
    const value = input.tapped;
    lastReply = question.options[value] ?? "";
    transcript.push({ role: "person", text: lastReply, tapped: value, at: nowIso() });
    next = applyConfirmation(state, questionIndex, value);
    provenance.push({ questionIndex, value, certainty: "tapped", quote: "", turn: state.turn });
  } else {
    const reply = (input.reply ?? "").trim();
    lastReply = reply;
    transcript.push({ role: "person", text: reply, at: nowIso() });

    // ONLY the question just asked. Never the open set — see the note at the top of the file.
    //
    // On a narrowing turn the reply is usually deictic — "yes", "the first one", "more the
    // second" — which matches no option text on its own, so the extractor abstains and the
    // interview asks again forever. Give it the referent by replaying what was asked; the
    // question and its options are unchanged, so the instrument is not altered.
    const utterance =
      shown.kind === "confirm" ? `The interviewer asked: "${lastAgentText(transcript)}"\n\nThey replied: "${reply}"` : reply;
    const heard = reply ? await extract([questionIndex], utterance) : [];
    const hit = heard.find((h) => h.questionIndex === questionIndex);

    if (hit && shown.kind === "confirm" && hit.confidence >= CONFIRM_THRESHOLD) {
      // They were asked to adjudicate between named options and answered clearly. Their word
      // is final, so this settles rather than proposes.
      next = applyConfirmation(state, questionIndex, hit.value);
      provenance.push({ questionIndex, value: hit.value, certainty: "confirmed", quote: hit.quote, turn: state.turn });
    } else if (hit && shown.kind === "confirm") {
      // A narrowing question answered with a still-uncertain read settles nothing. Contract
      // rule 4: an uncertain answer is never kept, and no provenance is written — the
      // record exists to say why a settled answer is what it is, and nothing is settled.
      // The always-present option tiles are the way out of the loop.
    } else if (hit) {
      next = applyExtractions(state, [{ questionIndex, value: hit.value, confidence: hit.confidence }]);
      // Only a SETTLED answer earns a provenance record. Below the threshold the controller
      // marks the slot proposed and asks a narrowing question; writing a record then would
      // both imply an answer exists and shadow the real one when the person adjudicates.
      if (hit.confidence >= CONFIRM_THRESHOLD) {
        provenance.push({ questionIndex, value: hit.value, certainty: hit.certainty, quote: hit.quote, turn: state.turn });
      }
    }
    // Nothing heard: apply nothing. The slot stays unfilled, so the controller asks the same
    // question again on the line below — a re-ask costs a turn, and guessing costs the
    // archetype. The budget bounds how many times this can happen.
    if (!hit) missed = true;
  }

  const move = nextMove(next);

  if (move.kind === "complete") {
    return finish(draft, move.answers, transcript, provenance, next);
  }

  if (move.kind === "fallback") {
    // The last answer of the budget landed; hand the rest over without a further model call.
    await persist(draft.id, { answers: answersOf(next), transcript, provenance, turn: next.turn });
    return fallbackResponse(move.remaining);
  }

  const text =
    move.kind === "confirm"
      ? narrowingAsk(move.text, move.options, move.value)
      : await phrase(move.text, lastReply || null, missed);

  const committed = commitMove(next, move);
  transcript.push({ role: "agent", text, questionIndex: move.questionIndex, kind: move.kind, at: nowIso() });

  await persist(draft.id, { answers: answersOf(committed), transcript, provenance, turn: committed.turn });

  const ask = agentTurn(text, move.questionIndex, move.kind, move.options, committed);
  // A re-ask reveals the options in the UI. Someone whose answer just missed is precisely
  // who needs the floor put in front of them rather than tucked behind a disclosure.
  return { status: "continue", ask: missed ? { ...ask, retry: true } : ask };
}

/**
 * Life after the turn budget.
 *
 * `TurnRequest` carries a tap but not the question it belongs to, so a tap here settles the
 * FIRST question still outstanding and the response returns the shortened list. The client
 * therefore has to work through `questions` in the order it is given, whatever order the
 * person filled the form in — that is the contract, and it is the reason each tap gets its
 * own round trip instead of one bulk submit. No model call is made on this path at all.
 */
async function drain(
  draft: InterviewDraft,
  state: InterviewState,
  remaining: number[],
  input: TurnRequest,
): Promise<TurnResponse> {
  if (input.tapped === undefined || remaining.length === 0) {
    // Typing is over — there is no budget left to interpret it with. Re-state what is owed
    // rather than burning an extraction on words that cannot be acted on.
    return fallbackResponse(remaining);
  }

  const questionIndex = remaining[0];
  const value = input.tapped;

  const transcript: TranscriptTurn[] = [
    ...draft.transcript,
    { role: "person", text: clientQuestions[questionIndex].options[value] ?? "", tapped: value, at: nowIso() },
  ];
  const provenance: AnswerProvenance[] = [
    ...draft.provenance,
    { questionIndex, value, certainty: "tapped", quote: "", turn: state.turn },
  ];

  // A fallback move does not advance the turn counter, so draining cannot run the budget
  // further into the red however many taps it takes.
  const next = applyConfirmation(state, questionIndex, value);
  const move = nextMove(next);

  if (move.kind === "complete") {
    return finish(draft, move.answers, transcript, provenance, next);
  }

  await persist(draft.id, { answers: answersOf(next), transcript, provenance, turn: next.turn });
  return fallbackResponse(move.kind === "fallback" ? move.remaining : remaining.filter((q) => q !== questionIndex));
}

/* ------------------------------------------------------------------ *
 * Completion — the one and only write to `responses`
 * ------------------------------------------------------------------ */

async function finish(
  draft: InterviewDraft,
  answers: number[],
  transcript: TranscriptTurn[],
  provenance: AnswerProvenance[],
  state: InterviewState,
): Promise<TurnResponse> {
  // Save the draft BEFORE the permanent write. If `createInterviewCompletion` fails, the
  // twenty-fifth answer is still on the draft and the next request finishes the job; without
  // this, a database blip on the last turn would cost somebody the entire interview.
  //
  // A null here means the draft expired between reading it and now. Nothing can be done
  // about that, and it is no reason to withhold a scorecard the person has earned.
  await saveDraft(draft.id, { answers, transcript, provenance, turn: state.turn });

  // Scoring is server-side and pure, exactly as it is for the tap form. The model has never
  // seen a mapping and neither has the client.
  const scored = score(answers);
  const teamId = draft.teamSlug ? await teamIdBySlug(draft.teamSlug) : null;

  // Consumes the draft and writes the response + team in one transaction — see the note on
  // createInterviewCompletion for why that atomicity is the point. `null` means some other
  // attempt (most often this same request's own retry, after its first response was lost to
  // the person's connection) already completed this draft; there is no resultId to recover
  // here, so this is reported the same way an unrecognised draft is.
  const result = await createInterviewCompletion({
    draftId: draft.id,
    contact: draft.contact,
    answers,
    scored,
    eventSlug: draft.eventSlug,
    teamId,
    intakeMode: intakeModeOf(state),
  });

  if (!result) {
    throw new InterviewError("draft_not_found", "That interview has already been completed.");
  }

  return { status: "complete", resultId: result.resultId };
}

/**
 * Which instrument gathered these 25.
 *
 * The distinction that matters for the baseline is the TURN BUDGET, not the tap: somebody
 * who taps the escape hatch every turn was still interviewed — asked one question at a time,
 * in the interview's order — whereas a draft that ran out of turns finished on the form.
 * Only the second is a different instrument.
 */
function intakeModeOf(state: InterviewState): IntakeMode {
  return state.turn >= state.config.maxTurns ? "interview_fallback" : "interview";
}

/* ------------------------------------------------------------------ *
 * Rehydration
 * ------------------------------------------------------------------ */

/**
 * Rebuild the controller from what was stored. Pure state machine plus stored answers is the
 * same interview, so there is nothing to serialise and nothing that can fall out of step with
 * the row.
 */
function rehydrate(draft: InterviewDraft): InterviewState {
  // Restore the counter first: the controller stamps the current turn onto every slot it
  // touches, and it is also what the budget is measured against.
  let state: InterviewState = { ...createInterview(SESSION_CONFIG), turn: draft.turn };

  for (let q = 0; q < QUESTION_COUNT; q += 1) {
    const value = draft.answers[q];
    if (value !== null) state = applyConfirmation(state, q, value);
  }

  // A live proposal is deliberately NOT restored. `provenance` records settled answers
  // only, so there is nothing to rebuild from — and nothing needs it: a narrowing reply is
  // interpreted from the transcript (`shown.kind === "confirm"`), not from controller
  // state. The cost of forgetting a proposal across a turn is that the controller may ask
  // again, which is a turn. The cost of restoring one wrongly is a kept answer nobody gave.

  return state;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** The settled answers, in the contract's shape: null wherever nothing has been kept yet. */
function answersOf(state: InterviewState): (number | null)[] {
  return state.slots.map((slot) => (slot.status === "confirmed" ? slot.value : null));
}

/** The question the person is answering: the last thing the agent actually put to them. */
/** The agent's most recent words — the referent a deictic reply points at. */
function lastAgentText(transcript: TranscriptTurn[]): string {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const turn = transcript[i];
    if (turn.role === "agent") return turn.text;
  }
  return "";
}

function lastAsked(transcript: TranscriptTurn[]): { questionIndex: number; kind: "ask" | "confirm" } | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const turn = transcript[i];
    if (turn.role === "agent") return { questionIndex: turn.questionIndex, kind: turn.kind };
  }
  return null;
}

function agentTurn(
  text: string,
  questionIndex: number,
  kind: "ask" | "confirm",
  options: string[],
  state: InterviewState,
): AgentTurn {
  return { text, questionIndex, kind, options, progress: progressOf(state) };
}

/**
 * Fraction of the 25 that are settled, for the progress bar.
 *
 * Still a fraction rather than a count, but no longer because counts are hidden — the UI now
 * shows "Question N of 25" (Mark's call, 14 Aug, reversing the original decision to withhold
 * it). The reason it must not BE that count is mechanical: this measures settled slots, and a
 * low-confidence answer stays unsettled until a later narrowing turn confirms it, so a count
 * taken from here would stall and then jump. The visible number comes from `questionIndex`.
 *
 * The original concern stands and is worth remembering: someone who can see how many remain
 * may start answering to finish rather than answering honestly.
 */
function progressOf(state: InterviewState): number {
  return state.slots.filter((slot) => slot.status === "confirmed").length / QUESTION_COUNT;
}

function fallbackResponse(remaining: number[]): TurnResponse {
  return {
    status: "fallback",
    remaining,
    // The client-safe question payload — text and option wording only, never the mappings.
    questions: remaining.map((index) => ({
      index,
      text: clientQuestions[index].text,
      options: clientQuestions[index].options,
    })),
  };
}

/**
 * Write the turn. A draft that has expired underneath us is reported as such rather than
 * left to look like a save that worked: the person can be told their session lapsed, which
 * is actionable, instead of watching answers quietly fail to stick.
 */
async function persist(id: string, patch: DraftPatch): Promise<void> {
  const saved = await saveDraft(id, patch);
  if (!saved) {
    throw new InterviewError(
      "draft_expired",
      `That interview has been idle more than ${INTERVIEW_LIMITS.draftTtlHours} hours.`,
    );
  }
}

/**
 * Phrase an ask, and never let it cost a turn. `askFor` already falls back to the plain
 * question when the model refuses or paraphrases; this extends the same treatment to an
 * outage. The question is the instrument, the acknowledgement is manners.
 */
async function phrase(questionText: string, lastReply: string | null, missed = false): Promise<string> {
  try {
    const { text } = missed && lastReply ? await reAskFor(questionText, lastReply) : await askFor(questionText, lastReply);
    return text;
  } catch (error) {
    // Never log the reply — it is the person's own words. The message alone is enough to see
    // that phrasing is down.
    console.warn("[interview] phrasing unavailable, asking plainly", error instanceof Error ? error.message : error);
    return questionText;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
