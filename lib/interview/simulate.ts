import { score } from "@/lib/scoring";
import {
  applyConfirmation,
  applyExtractions,
  applyFallback,
  commitMove,
  createInterview,
  nextMove,
  remaining,
  type InterviewConfig,
} from "./controller";
import { makeRng } from "./leverage";
import { confirmAnswer, respond, tapRemaining, type ExtractorProfile, type Persona } from "./persona";

export type InterviewResult = {
  personaId: string;
  /** Moves that cost the person something: asks and confirms. */
  turns: number;
  asks: number;
  confirms: number;
  /** True when the turn budget ran out and the rest fell back to tapping. */
  fellBack: boolean;
  tappedAtFallback: number;
  /** The archetype the interview produced. */
  archetype: number;
  /** The archetype the tap form would have produced for the same person. */
  truthArchetype: number;
  agreed: boolean;
  /** How many of the 25 ended up different from the person's real answers. */
  wrongAnswers: number;
};

/**
 * Run one interview to completion. Deterministic for a given seed.
 *
 * The loop is deliberately dumb: ask what the controller says to ask, feed back what the
 * simulated extractor heard, repeat. All the intelligence under test lives in the
 * controller's choice of what to ask next and when to stop.
 */
export function runInterview(
  persona: Persona,
  config: Partial<InterviewConfig>,
  extractor: ExtractorProfile,
  seed: number,
): InterviewResult {
  let state = createInterview({ ...config, seed });
  const rng = makeRng(seed * 7919 + 13);

  let asks = 0;
  let confirms = 0;
  let fellBack = false;
  let tappedAtFallback = 0;

  // The budget bounds this loop; the guard is a backstop against a controller bug, and
  // failing loudly here beats spinning forever in a sweep.
  for (let guard = 0; guard <= (config.maxTurns ?? 30) + 5; guard += 1) {
    const move = nextMove(state);

    if (move.kind === "complete") {
      const answers = move.answers;
      const truthArchetype = score(persona.truth).profile;
      const archetype = score(answers).profile;
      return {
        personaId: persona.id,
        turns: asks + confirms,
        asks,
        confirms,
        fellBack,
        tappedAtFallback,
        archetype,
        truthArchetype,
        agreed: archetype === truthArchetype,
        wrongAnswers: answers.filter((a, i) => a !== persona.truth[i]).length,
      };
    }

    if (move.kind === "fallback") {
      fellBack = true;
      tappedAtFallback = move.remaining.length;
      state = applyFallback(state, tapRemaining(persona, move.remaining));
      state = commitMove(state, move);
      continue;
    }

    if (move.kind === "confirm") {
      confirms += 1;
      state = commitMove(state, move);
      state = applyConfirmation(state, move.questionIndex, confirmAnswer(persona, move.questionIndex, extractor, rng));
      continue;
    }

    asks += 1;
    state = commitMove(state, move);
    const open = remaining(state).filter((q) => state.slots[q].status === "unfilled");
    state = applyExtractions(state, respond(persona, move.questionIndex, open, extractor, rng));
  }

  throw new Error(`Interview for ${persona.id} did not terminate within the guard`);
}

export type Summary = {
  n: number;
  agreement: number;
  meanTurns: number;
  medianTurns: number;
  p90Turns: number;
  meanConfirms: number;
  fallbackRate: number;
  meanWrongAnswers: number;
};

export function summarise(results: InterviewResult[]): Summary {
  const turns = results.map((r) => r.turns).sort((a, b) => a - b);
  const pick = (q: number) => turns[Math.min(turns.length - 1, Math.floor(turns.length * q))];
  return {
    n: results.length,
    agreement: (results.filter((r) => r.agreed).length / results.length) * 100,
    meanTurns: turns.reduce((a, b) => a + b, 0) / results.length,
    medianTurns: pick(0.5),
    p90Turns: pick(0.9),
    meanConfirms: results.reduce((a, r) => a + r.confirms, 0) / results.length,
    fallbackRate: (results.filter((r) => r.fellBack).length / results.length) * 100,
    meanWrongAnswers: results.reduce((a, r) => a + r.wrongAnswers, 0) / results.length,
  };
}
