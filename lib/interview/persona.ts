import { OPTIONS_PER_QUESTION, QUESTION_COUNT, optionIndexById, questions, score, testVectors } from "@/lib/scoring";
import { makeRng } from "./leverage";
import type { Extraction } from "./controller";

/**
 * Simulated interviewees, with known ground truth.
 *
 * The point of the harness is to measure whether the CONTROLLER converges, and what
 * extraction quality it needs, before anyone builds a conversational surface or spends a
 * cent on model calls. So the person and the extractor are both simulated, and the thing
 * under test is the loop.
 *
 * What is modelled, and why:
 *   - accuracy — the extractor hears the right option only some of the time.
 *   - confidence — real extractors are usually, but not always, confident when correct.
 *     Errors that arrive wearing high confidence are precisely what the threshold cannot
 *     catch, so they must be modelled or the harness flatters itself.
 *   - spillover — one answer often settles several questions at once. This is the whole
 *     argument for a conversational intake, so it has to be in the model.
 *   - confirmation — a narrowing question ("A or B?") is easier than open extraction, so
 *     it is more accurate, but not perfect.
 */

export type Persona = {
  id: string;
  /** The answers this person would have given by tapping — the ground truth. */
  truth: number[];
  /** The archetype the form would have produced. */
  archetype: number;
};

export type ExtractorProfile = {
  /** Probability the extractor picks the right option for the question actually asked. */
  accuracy: number;
  /** Probability that answering one question also settles others. */
  spilloverRate: number;
  /** How many extra questions a spillover settles, at most. */
  spilloverMax: number;
  /** Accuracy on a direct narrowing question. */
  confirmAccuracy: number;
};

export const DEFAULT_EXTRACTOR: ExtractorProfile = {
  accuracy: 0.9,
  spilloverRate: 0.5,
  spilloverMax: 3,
  confirmAccuracy: 0.97,
};

/**
 * Build personas by perturbing the schema's real replay vectors rather than sampling
 * uniformly: real answer sets are correlated, and uniform noise would make the problem
 * look easier than it is.
 */
export function buildPersonas(count: number, seed = 7): Persona[] {
  const rng = makeRng(seed);
  const bases = testVectors.map((v) => questions.map((q, qi) => optionIndexById(qi, v.answers[q.id])));
  const personas: Persona[] = [];

  for (let i = 0; i < count; i += 1) {
    const truth = [...bases[Math.floor(rng() * bases.length)]];
    const edits = 3 + Math.floor(rng() * 8);
    for (let e = 0; e < edits; e += 1) {
      truth[Math.floor(rng() * QUESTION_COUNT)] = Math.floor(rng() * OPTIONS_PER_QUESTION);
    }
    personas.push({ id: `p${i + 1}`, truth, archetype: score(truth).profile });
  }

  return personas;
}

/** Confidence for a heard answer. Correct answers skew high, but errors are not all timid. */
function confidenceFor(correct: boolean, rng: () => number): number {
  return correct ? 0.72 + rng() * 0.28 : 0.45 + rng() * 0.45;
}

function wrongOption(truth: number, rng: () => number): number {
  let w = Math.floor(rng() * OPTIONS_PER_QUESTION);
  while (w === truth) w = Math.floor(rng() * OPTIONS_PER_QUESTION);
  return w;
}

/**
 * The person answers the question they were asked, and — sometimes — says enough to settle
 * other still-open questions at the same time.
 */
export function respond(
  persona: Persona,
  questionIndex: number,
  stillOpen: number[],
  profile: ExtractorProfile,
  rng: () => number,
): Extraction[] {
  const out: Extraction[] = [];

  const heardRight = rng() < profile.accuracy;
  const truth = persona.truth[questionIndex];
  out.push({
    questionIndex,
    value: heardRight ? truth : wrongOption(truth, rng),
    confidence: confidenceFor(heardRight, rng),
  });

  if (rng() < profile.spilloverRate) {
    const candidates = stillOpen.filter((q) => q !== questionIndex);
    const n = Math.min(candidates.length, 1 + Math.floor(rng() * profile.spilloverMax));
    // Sample without replacement.
    const pool = [...candidates];
    for (let k = 0; k < n; k += 1) {
      const pick = pool.splice(Math.floor(rng() * pool.length), 1)[0];
      const right = rng() < profile.accuracy;
      out.push({
        questionIndex: pick,
        value: right ? persona.truth[pick] : wrongOption(persona.truth[pick], rng),
        confidence: confidenceFor(right, rng),
      });
    }
  }

  return out;
}

/** The person resolves a narrowing question. Easier than open extraction, still not perfect. */
export function confirmAnswer(
  persona: Persona,
  questionIndex: number,
  profile: ExtractorProfile,
  rng: () => number,
): number {
  const truth = persona.truth[questionIndex];
  return rng() < profile.confirmAccuracy ? truth : wrongOption(truth, rng);
}

/** The person taps the leftovers after a fallback. Tapping is taken as ground truth. */
export function tapRemaining(persona: Persona, remaining: number[]): Map<number, number> {
  return new Map(remaining.map((q) => [q, persona.truth[q]]));
}
