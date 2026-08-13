import { describe, expect, it } from "vitest";
import schemaJson from "@/inputs/archetype-schema.json";
import {
  OPTIONS_PER_QUESTION,
  PROFILE_COUNT,
  QUESTION_COUNT,
  clientQuestions,
  mapping,
  optionIndexById,
  questions,
  score,
  testVectors,
} from "@/lib/scoring";

/**
 * The replay suite. If anything here fails, the SCORING IMPLEMENTATION is wrong —
 * never the schema and never the test.
 */
describe("scoring replay vectors", () => {
  it("ships all eight vectors, including two that exercise the tie-break", () => {
    expect(testVectors).toHaveLength(8);
    expect(testVectors.filter((v) => v.tie_break_exercised)).toHaveLength(2);
  });

  for (const [index, vector] of testVectors.entries()) {
    it(`vector ${index + 1} reproduces exact totals and winner${vector.tie_break_exercised ? " (tie-break)" : ""}`, () => {
      const answers = questions.map((question, qi) => {
        const optionId = vector.answers[question.id];
        expect(optionId, `vector ${index + 1} is missing an answer for ${question.id}`).toBeDefined();
        return optionIndexById(qi, optionId);
      });

      const result = score(answers);

      for (let profile = 1; profile <= PROFILE_COUNT; profile += 1) {
        expect(result.totals[profile - 1], `profile ${profile}`).toBe(
          vector.expected_totals_by_profile[String(profile)],
        );
      }
      expect(result.profile).toBe(vector.expected_archetype);
    });
  }
});

describe("tie-break", () => {
  it("breaks ties to the lowest profile number", () => {
    const tied = testVectors.filter((v) => v.tie_break_exercised);
    for (const vector of tied) {
      const totals = Object.entries(vector.expected_totals_by_profile);
      const max = Math.max(...totals.map(([, value]) => value));
      const winners = totals.filter(([, value]) => value === max).map(([profile]) => Number(profile));
      expect(winners.length).toBeGreaterThan(1);
      expect(vector.expected_archetype).toBe(Math.min(...winners));
    }
  });
});

describe("option mappings", () => {
  it("matches the schema for every one of the 100 options, applied one at a time", () => {
    let checked = 0;
    for (let qi = 0; qi < QUESTION_COUNT; qi += 1) {
      for (let oi = 0; oi < OPTIONS_PER_QUESTION; oi += 1) {
        // Answer this question with this option; park every other question on an
        // option that scores nothing where possible, otherwise subtract its contribution.
        const answers = new Array<number>(QUESTION_COUNT).fill(0);
        answers[qi] = oi;

        const baseline = new Array<number>(PROFILE_COUNT).fill(0);
        for (let other = 0; other < QUESTION_COUNT; other += 1) {
          if (other === qi) continue;
          for (const p of mapping[other][0]) baseline[p - 1] += 1;
        }

        const result = score(answers);
        const isolated = result.totals.map((total, i) => total - baseline[i]);

        const expected = new Array<number>(PROFILE_COUNT).fill(0);
        for (const p of schemaJson.questions[qi].options[oi].profiles) expected[p - 1] += 1;

        expect(isolated, `question ${qi + 1} option ${oi + 1}`).toEqual(expected);
        checked += 1;
      }
    }
    expect(checked).toBe(100);
  });

  it("keeps the options that legitimately score nothing", () => {
    const emptyOptions = schemaJson.questions.flatMap((q) => q.options).filter((o) => o.profiles.length === 0);
    expect(emptyOptions.length).toBe(26);
  });
});

describe("purity", () => {
  it("returns the same result for the same input and does not mutate its argument", () => {
    const answers = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0];
    const snapshot = [...answers];
    const first = score(answers);
    const second = score(answers);
    expect(first).toEqual(second);
    expect(answers).toEqual(snapshot);
  });

  it("returns fresh arrays so callers cannot corrupt later scores", () => {
    const answers = new Array<number>(QUESTION_COUNT).fill(0);
    const first = score(answers);
    first.totals[0] = 999;
    expect(score(answers).totals[0]).not.toBe(999);
  });

  it("rejects malformed answers rather than guessing", () => {
    expect(() => score([1, 2, 3])).toThrow(/Expected 25 answers/);
    expect(() => score(new Array<number>(QUESTION_COUNT).fill(4))).toThrow(/must be an integer/);
    expect(() => score(new Array<number>(QUESTION_COUNT).fill(-1))).toThrow(/must be an integer/);
  });
});

describe("client payload", () => {
  it("never exposes the profile mappings to the browser", () => {
    expect(clientQuestions).toHaveLength(QUESTION_COUNT);
    const serialised = JSON.stringify(clientQuestions);
    expect(serialised).not.toContain("profiles");
    for (const question of clientQuestions) {
      expect(question.options).toHaveLength(OPTIONS_PER_QUESTION);
    }
  });
});
