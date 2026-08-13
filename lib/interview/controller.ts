import { OPTIONS_PER_QUESTION, QUESTION_COUNT, questions } from "@/lib/scoring";
import { discrimination, makeRng, pivotality, type KnownAnswers } from "./leverage";

/**
 * THE INTERVIEW CONTROLLER.
 *
 * The controller owns slot selection; a language model owns nothing but phrasing. That
 * split is the whole risk posture:
 *
 *   - the loop provably terminates with 25 answers, because a deterministic state machine
 *     decides what is still missing and when to stop;
 *   - a slot is never filled without evidence, because only extraction results and explicit
 *     confirmations can write to it;
 *   - the option→profile mappings never leave the server, because the model is handed a
 *     question index and the question's own text, never the reason it was chosen.
 *
 * There is no model call anywhere in this file. It is pure, seeded and testable, which is
 * what lets it be the part that must never fail.
 */

export type SlotStatus = "unfilled" | "proposed" | "confirmed";

export type Slot = {
  status: SlotStatus;
  /** Option index 0-3 once something has been heard; null while unfilled. */
  value: number | null;
  /** Extractor confidence for a proposed value; 1 once confirmed by the person. */
  confidence: number;
  /** Which turn last touched this slot — useful for the audit trail. */
  turn: number | null;
};

export type InterviewConfig = {
  /** Hard ceiling on moves. On reaching it the remaining questions fall back to taps. */
  maxTurns: number;
  /** At or above this, an extraction is accepted; below it, the person is asked to confirm. */
  confidenceThreshold: number;
  /** How the next question is chosen. `sequential` exists as the control in experiments. */
  ordering: "leverage" | "sequential";
  seed: number;
  /** Monte Carlo samples per pivotality estimate. */
  leverageSamples: number;
};

export const DEFAULT_CONFIG: InterviewConfig = {
  maxTurns: 30,
  confidenceThreshold: 0.75,
  ordering: "leverage",
  seed: 1,
  leverageSamples: 64,
};

export type InterviewState = {
  slots: Slot[];
  turn: number;
  config: InterviewConfig;
  /** Every move issued, in order — the audit trail for "why did I get this?". */
  history: Move[];
  rng: () => number;
};

export type Move =
  /** Ask about this question. `text` is the schema's own wording — the fixed stimulus. */
  | { kind: "ask"; questionIndex: number; text: string; options: string[]; pivotality: number }
  /** Heard something, but not confidently enough to keep it. Narrow it down. */
  | { kind: "confirm"; questionIndex: number; text: string; options: string[]; value: number; confidence: number }
  /** Out of turns. Hand the rest to the tap form rather than guess. */
  | { kind: "fallback"; remaining: number[] }
  /** All 25 settled. */
  | { kind: "complete"; answers: number[] };

export function createInterview(config: Partial<InterviewConfig> = {}): InterviewState {
  const merged = { ...DEFAULT_CONFIG, ...config };
  return {
    slots: Array.from({ length: QUESTION_COUNT }, () => ({
      status: "unfilled" as SlotStatus,
      value: null,
      confidence: 0,
      turn: null,
    })),
    turn: 0,
    config: merged,
    history: [],
    rng: makeRng(merged.seed),
  };
}

export function knownAnswers(state: InterviewState): KnownAnswers {
  // A proposed value counts as known for pivotality: it is our current best belief, and
  // treating it as unknown would make the estimate needlessly pessimistic.
  return state.slots.map((s) => (s.status === "unfilled" ? null : s.value));
}

export function remaining(state: InterviewState): number[] {
  return state.slots.map((s, i) => (s.status === "confirmed" ? -1 : i)).filter((i) => i >= 0);
}

export function isComplete(state: InterviewState): boolean {
  return state.slots.every((s) => s.status === "confirmed");
}

/**
 * Decide the next move. Pure with respect to state apart from advancing the seeded RNG;
 * calling it does not mutate the interview.
 */
export function nextMove(state: InterviewState): Move {
  if (isComplete(state)) {
    return { kind: "complete", answers: state.slots.map((s) => s.value as number) };
  }

  if (state.turn >= state.config.maxTurns) {
    return { kind: "fallback", remaining: remaining(state) };
  }

  // Settle what we half-know before opening new ground: an unconfirmed value is the single
  // largest source of a wrong archetype, and confirming costs one cheap narrowing question.
  const proposed = state.slots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.status === "proposed");

  if (proposed.length > 0) {
    const target = rank(
      state,
      proposed.map(({ i }) => i),
    ).order[0];
    const slot = state.slots[target];
    return {
      kind: "confirm",
      questionIndex: target,
      text: questions[target].text,
      options: questions[target].options.map((o) => o.text),
      value: slot.value as number,
      confidence: slot.confidence,
    };
  }

  const unfilled = state.slots.map((s, i) => ({ s, i })).filter(({ s }) => s.status === "unfilled").map(({ i }) => i);
  const { order, scores } = rank(state, unfilled);
  const target = order[0];

  return {
    kind: "ask",
    questionIndex: target,
    text: questions[target].text,
    options: questions[target].options.map((o) => o.text),
    pivotality: scores.get(target) ?? 0,
  };
}

/**
 * Order candidate questions best-first under the configured strategy, returning the scores
 * alongside so callers need no module-level state. Nothing here is memoised: the estimate
 * depends on what is already known, which changes every turn.
 */
function rank(state: InterviewState, candidates: number[]): { order: number[]; scores: Map<number, number> } {
  if (candidates.length <= 1) return { order: candidates, scores: new Map(candidates.map((q) => [q, 0])) };

  if (state.config.ordering === "sequential") {
    return { order: [...candidates].sort((a, b) => a - b), scores: new Map(candidates.map((q) => [q, 0])) };
  }

  const scores = pivotality(knownAnswers(state), candidates, state.config.leverageSamples, state.rng);

  const order = [...candidates].sort((a, b) => {
    const diff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (Math.abs(diff) > 1e-9) return diff;
    // Ties go to the question that discriminates most, then to the lower index so the
    // ordering is total and reproducible.
    const disc = discrimination[b] - discrimination[a];
    return disc !== 0 ? disc : a - b;
  });

  return { order, scores };
}

export type Extraction = { questionIndex: number; value: number; confidence: number };

/**
 * Apply what the extractor heard. One utterance may settle several questions at once —
 * that is the point of the design — so this takes a list.
 *
 * Confirmed slots are never overwritten, and out-of-range values are rejected rather than
 * clamped: silently coercing a bad index is exactly how a wrong archetype gets shipped.
 */
export function applyExtractions(state: InterviewState, extractions: Extraction[]): InterviewState {
  const slots = state.slots.map((s) => ({ ...s }));

  for (const e of extractions) {
    if (!Number.isInteger(e.questionIndex) || e.questionIndex < 0 || e.questionIndex >= QUESTION_COUNT) {
      throw new Error(`Extraction for unknown question ${e.questionIndex}`);
    }
    if (!Number.isInteger(e.value) || e.value < 0 || e.value >= OPTIONS_PER_QUESTION) {
      throw new Error(`Extraction for question ${e.questionIndex} has invalid option ${e.value}`);
    }
    const slot = slots[e.questionIndex];
    if (slot.status === "confirmed") continue;

    slot.value = e.value;
    slot.confidence = e.confidence;
    slot.status = e.confidence >= state.config.confidenceThreshold ? "confirmed" : "proposed";
    slot.turn = state.turn;
  }

  return { ...state, slots };
}

/** The person answered a narrowing question. Their word is final. */
export function applyConfirmation(state: InterviewState, questionIndex: number, value: number): InterviewState {
  if (!Number.isInteger(value) || value < 0 || value >= OPTIONS_PER_QUESTION) {
    throw new Error(`Confirmation for question ${questionIndex} has invalid option ${value}`);
  }
  const slots = state.slots.map((s) => ({ ...s }));
  slots[questionIndex] = { status: "confirmed", value, confidence: 1, turn: state.turn };
  return { ...state, slots };
}

/** The person tapped the remaining questions after a fallback. */
export function applyFallback(state: InterviewState, answers: Map<number, number>): InterviewState {
  let next = state;
  for (const [questionIndex, value] of answers) next = applyConfirmation(next, questionIndex, value);
  return next;
}

/** Record a move and advance the turn counter. */
export function commitMove(state: InterviewState, move: Move): InterviewState {
  const counts = move.kind === "ask" || move.kind === "confirm";
  return { ...state, turn: counts ? state.turn + 1 : state.turn, history: [...state.history, move] };
}
