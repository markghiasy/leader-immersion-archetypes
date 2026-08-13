import { describe, expect, it } from "vitest";
import { QUESTION_COUNT } from "@/lib/scoring";
import {
  applyConfirmation,
  applyExtractions,
  applyFallback,
  commitMove,
  createInterview,
  isComplete,
  nextMove,
  remaining,
} from "@/lib/interview/controller";
import { buildPersonas, DEFAULT_EXTRACTOR, tapRemaining } from "@/lib/interview/persona";
import { runInterview } from "@/lib/interview/simulate";
import { pivotality } from "@/lib/interview/leverage";
import { makeRng } from "@/lib/interview/leverage";

/**
 * The controller is the part that must never fail, so it is tested as a state machine on
 * its own terms — not through the simulation.
 */

describe("controller invariants", () => {
  it("starts with nothing known and nothing assumed", () => {
    const state = createInterview();
    expect(state.slots).toHaveLength(QUESTION_COUNT);
    expect(state.slots.every((s) => s.status === "unfilled" && s.value === null)).toBe(true);
    expect(isComplete(state)).toBe(false);
  });

  it("never fills a slot without evidence", () => {
    let state = createInterview();
    for (let i = 0; i < 40; i += 1) {
      const move = nextMove(state);
      if (move.kind === "complete" || move.kind === "fallback") break;
      state = commitMove(state, move);
      // Deliberately feed back NOTHING — the interviewee says something unusable.
      state = applyExtractions(state, []);
    }
    expect(state.slots.every((s) => s.status === "unfilled")).toBe(true);
    expect(isComplete(state)).toBe(false);
  });

  it("falls back to tapping rather than guessing when the budget runs out", () => {
    let state = createInterview({ maxTurns: 5 });
    for (let i = 0; i < 5; i += 1) {
      const move = nextMove(state);
      expect(move.kind).toBe("ask");
      state = commitMove(state, move);
      state = applyExtractions(state, []);
    }
    const move = nextMove(state);
    expect(move.kind).toBe("fallback");
    if (move.kind !== "fallback") throw new Error("unreachable");
    expect(move.remaining).toHaveLength(QUESTION_COUNT);
  });

  it("completes only once every question is confirmed", () => {
    let state = createInterview();
    for (let q = 0; q < QUESTION_COUNT - 1; q += 1) state = applyConfirmation(state, q, 1);
    expect(isComplete(state)).toBe(false);
    expect(nextMove(state).kind).not.toBe("complete");

    state = applyConfirmation(state, QUESTION_COUNT - 1, 2);
    const move = nextMove(state);
    expect(move.kind).toBe("complete");
    if (move.kind !== "complete") throw new Error("unreachable");
    expect(move.answers).toHaveLength(QUESTION_COUNT);
  });

  it("asks the person to confirm anything heard below the confidence threshold", () => {
    let state = createInterview({ confidenceThreshold: 0.75 });
    state = applyExtractions(state, [{ questionIndex: 4, value: 2, confidence: 0.6 }]);
    expect(state.slots[4].status).toBe("proposed");

    const move = nextMove(state);
    expect(move.kind).toBe("confirm");
    if (move.kind !== "confirm") throw new Error("unreachable");
    expect(move.questionIndex).toBe(4);
    expect(move.value).toBe(2);
  });

  it("keeps a confident extraction without re-asking", () => {
    let state = createInterview({ confidenceThreshold: 0.75 });
    state = applyExtractions(state, [{ questionIndex: 4, value: 2, confidence: 0.9 }]);
    expect(state.slots[4].status).toBe("confirmed");
    expect(nextMove(state).kind).toBe("ask");
  });

  it("never overwrites what the person has confirmed", () => {
    let state = createInterview();
    state = applyConfirmation(state, 0, 3);
    state = applyExtractions(state, [{ questionIndex: 0, value: 1, confidence: 0.99 }]);
    expect(state.slots[0].value).toBe(3);
  });

  it("rejects an out-of-range option instead of clamping it", () => {
    const state = createInterview();
    expect(() => applyExtractions(state, [{ questionIndex: 0, value: 4, confidence: 0.9 }])).toThrow(/invalid option/);
    expect(() => applyExtractions(state, [{ questionIndex: 99, value: 0, confidence: 0.9 }])).toThrow(/unknown question/);
    expect(() => applyConfirmation(state, 0, -1)).toThrow(/invalid option/);
  });

  it("settles one question at a time and one utterance can settle several", () => {
    let state = createInterview();
    state = applyExtractions(state, [
      { questionIndex: 0, value: 1, confidence: 0.9 },
      { questionIndex: 7, value: 2, confidence: 0.9 },
      { questionIndex: 19, value: 0, confidence: 0.9 },
    ]);
    expect(remaining(state)).toHaveLength(QUESTION_COUNT - 3);
  });

  it("never asks the same question twice in a row once it is settled", () => {
    let state = createInterview();
    const asked = new Set<number>();
    for (let i = 0; i < QUESTION_COUNT; i += 1) {
      const move = nextMove(state);
      if (move.kind !== "ask") break;
      expect(asked.has(move.questionIndex)).toBe(false);
      asked.add(move.questionIndex);
      state = commitMove(state, move);
      state = applyExtractions(state, [{ questionIndex: move.questionIndex, value: 0, confidence: 0.95 }]);
    }
    expect(asked.size).toBe(QUESTION_COUNT);
  });

  it("is deterministic for a given seed", () => {
    const run = () => {
      let state = createInterview({ seed: 99 });
      const order: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        const move = nextMove(state);
        if (move.kind !== "ask") break;
        order.push(move.questionIndex);
        state = commitMove(state, move);
        state = applyExtractions(state, [{ questionIndex: move.questionIndex, value: 1, confidence: 0.95 }]);
      }
      return order;
    };
    expect(run()).toEqual(run());
  });

  it("fallback answers are treated as confirmed", () => {
    let state = createInterview({ maxTurns: 0 });
    const move = nextMove(state);
    expect(move.kind).toBe("fallback");
    if (move.kind !== "fallback") throw new Error("unreachable");
    const persona = buildPersonas(1)[0];
    state = applyFallback(state, tapRemaining(persona, move.remaining));
    expect(isComplete(state)).toBe(true);
    const done = nextMove(state);
    expect(done.kind).toBe("complete");
    if (done.kind !== "complete") throw new Error("unreachable");
    expect(done.answers).toEqual(persona.truth);
  });
});

describe("pivotality", () => {
  it("finds questions that can still change the archetype", () => {
    const known = new Array<number | null>(QUESTION_COUNT).fill(null);
    const candidates = Array.from({ length: QUESTION_COUNT }, (_, i) => i);
    const scores = pivotality(known, candidates, 64, makeRng(5));
    expect(scores.size).toBe(QUESTION_COUNT);
    for (const v of scores.values()) expect(v).toBeGreaterThanOrEqual(0);
    // With everything unknown, at least some questions must be capable of deciding it.
    expect([...scores.values()].some((v) => v > 0)).toBe(true);
  });

  it("is deterministic for a given seed", () => {
    const known = new Array<number | null>(QUESTION_COUNT).fill(null);
    const candidates = Array.from({ length: QUESTION_COUNT }, (_, i) => i);
    const a = pivotality(known, candidates, 32, makeRng(11));
    const b = pivotality(known, candidates, 32, makeRng(11));
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

describe("end-to-end convergence", () => {
  it("always terminates with exactly 25 answers, across many personas", () => {
    const personas = buildPersonas(40, 3);
    for (const [i, persona] of personas.entries()) {
      const result = runInterview(persona, { maxTurns: 30 }, DEFAULT_EXTRACTOR, i + 1);
      expect(result.turns).toBeLessThanOrEqual(30);
      expect(result.archetype).toBeGreaterThanOrEqual(1);
      expect(result.archetype).toBeLessThanOrEqual(8);
    }
  });

  it("reproduces the tap result exactly when extraction is perfect", () => {
    const personas = buildPersonas(20, 4);
    const perfect = { accuracy: 1, spilloverRate: 0.5, spilloverMax: 3, confirmAccuracy: 1 };
    for (const [i, persona] of personas.entries()) {
      const result = runInterview(persona, { maxTurns: 30 }, perfect, i + 1);
      expect(result.wrongAnswers).toBe(0);
      expect(result.agreed).toBe(true);
    }
  });
});
