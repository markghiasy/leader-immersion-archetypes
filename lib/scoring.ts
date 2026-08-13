/**
 * Scoring — the frozen core of the app.
 *
 * The option -> profile mappings come from `inputs/archetype-schema.json`, which was
 * reverse-engineered from 499 real responses and validated 499/499. Nothing in this file
 * may be "improved": some options legitimately increment no profile at all, and the
 * tie-break is defined as LOWEST profile number, not most-recent or random.
 *
 * This module is pure and has no imports beyond the schema. It never runs on the client.
 */
import schemaJson from "@/inputs/archetype-schema.json";

export const PROFILE_COUNT = 8;
export const QUESTION_COUNT = 25;
export const OPTIONS_PER_QUESTION = 4;

export type SchemaOption = { id: string; text: string; profiles: number[] };
export type SchemaQuestion = { id: string; text: string; options: SchemaOption[] };
export type TestVector = {
  answers: Record<string, string>;
  expected_totals_by_profile: Record<string, number>;
  expected_archetype: number;
  tie_break_exercised: boolean;
};

export const questions: SchemaQuestion[] = schemaJson.questions as SchemaQuestion[];
export const testVectors: TestVector[] = schemaJson.test_vectors as TestVector[];

if (questions.length !== QUESTION_COUNT) {
  throw new Error(`archetype-schema.json must contain ${QUESTION_COUNT} questions, found ${questions.length}`);
}

/**
 * Pre-computed lookup: mapping[questionIndex][optionIndex] = profiles incremented.
 * Frozen so nothing downstream can mutate the source of truth.
 */
export const mapping: readonly (readonly (readonly number[])[])[] = Object.freeze(
  questions.map((q, qi) => {
    if (q.options.length !== OPTIONS_PER_QUESTION) {
      throw new Error(`Question ${qi + 1} (${q.id}) must have ${OPTIONS_PER_QUESTION} options`);
    }
    return Object.freeze(
      q.options.map((o) => {
        for (const p of o.profiles) {
          if (!Number.isInteger(p) || p < 1 || p > PROFILE_COUNT) {
            throw new Error(`Option ${o.id} references invalid profile ${p}`);
          }
        }
        return Object.freeze([...o.profiles]);
      }),
    );
  }),
);

export type ScoreResult = { totals: number[]; profile: number };

/**
 * Score a completed quiz.
 *
 * @param answers 25 zero-based option indexes (0-3), one per question, in question order.
 * @returns totals — 8 counters, index 0 = profile 1; profile — the winning profile number (1-8).
 */
export function score(answers: number[]): ScoreResult {
  if (answers.length !== QUESTION_COUNT) {
    throw new Error(`Expected ${QUESTION_COUNT} answers, received ${answers.length}`);
  }

  const totals = new Array<number>(PROFILE_COUNT).fill(0);

  for (let qi = 0; qi < QUESTION_COUNT; qi += 1) {
    const optionIndex = answers[qi];
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= OPTIONS_PER_QUESTION) {
      throw new Error(`Answer ${qi + 1} must be an integer 0-${OPTIONS_PER_QUESTION - 1}, received ${optionIndex}`);
    }
    // Some options map to no profile at all; that is correct, not a gap.
    for (const profile of mapping[qi][optionIndex]) {
      totals[profile - 1] += 1;
    }
  }

  // Highest total wins. Ties break to the LOWEST profile number, which a strict
  // greater-than comparison over ascending profile order gives us for free.
  let profile = 1;
  for (let p = 2; p <= PROFILE_COUNT; p += 1) {
    if (totals[p - 1] > totals[profile - 1]) profile = p;
  }

  return { totals, profile };
}

/** Resolve a schema option id (e.g. "q07o3") to its zero-based option index. */
export function optionIndexById(questionIndex: number, optionId: string): number {
  const index = questions[questionIndex].options.findIndex((o) => o.id === optionId);
  if (index === -1) throw new Error(`Unknown option id ${optionId} for question ${questionIndex + 1}`);
  return index;
}

/**
 * The question payload sent to the browser: text only, no profile mappings.
 * The client must never be able to compute or predict a score.
 */
export type ClientQuestion = { text: string; options: string[] };

export const clientQuestions: ClientQuestion[] = questions.map((q) => ({
  text: q.text,
  options: q.options.map((o) => o.text),
}));
