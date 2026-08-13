import { OPTIONS_PER_QUESTION, PROFILE_COUNT, QUESTION_COUNT, mapping } from "@/lib/scoring";

/**
 * Which unanswered questions could still change the outcome?
 *
 * The interview has a limited number of turns before people give up, so it should spend
 * them where the result is genuinely undecided rather than marching through 1..25. A
 * question is "pivotal" when, holding everything else as it stands, moving it across its
 * four options produces more than one winning archetype.
 *
 * Everything not yet known is sampled, because pivotality genuinely depends on the answers
 * that have not been given yet. The estimate is Monte Carlo over those unknowns and is
 * deterministic for a given seed.
 *
 * This lives on the server and never travels to the model: the phrasing layer is told
 * WHICH question to ask, never why, so the option→profile mappings stay behind the seam.
 */

/** Deterministic PRNG — reproducibility matters more than statistical purity here. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function winnerFromTotals(totals: number[]): number {
  let profile = 1;
  for (let p = 2; p <= PROFILE_COUNT; p += 1) {
    if (totals[p - 1] > totals[profile - 1]) profile = p;
  }
  return profile;
}

export type KnownAnswers = (number | null)[];

/**
 * @param known    length-25, an option index where the answer is settled, null where not.
 * @param candidates question indexes to score for pivotality.
 * @returns question index → share of sampled worlds in which it decides the archetype (0..1).
 */
export function pivotality(
  known: KnownAnswers,
  candidates: number[],
  samples: number,
  rng: () => number,
): Map<number, number> {
  const hits = new Map<number, number>(candidates.map((q) => [q, 0]));
  if (candidates.length === 0) return hits;

  const unknown: number[] = [];
  for (let q = 0; q < QUESTION_COUNT; q += 1) if (known[q] === null) unknown.push(q);

  const sample = new Array<number>(QUESTION_COUNT).fill(0);

  for (let s = 0; s < samples; s += 1) {
    // One plausible world: settled answers as given, everything else drawn at random.
    for (let q = 0; q < QUESTION_COUNT; q += 1) {
      sample[q] = known[q] ?? 0;
    }
    for (const q of unknown) sample[q] = Math.floor(rng() * OPTIONS_PER_QUESTION);

    const totals = new Array<number>(PROFILE_COUNT).fill(0);
    for (let q = 0; q < QUESTION_COUNT; q += 1) {
      for (const p of mapping[q][sample[q]]) totals[p - 1] += 1;
    }

    for (const q of candidates) {
      // Remove this question's contribution, then try each option in turn. Cheaper than
      // rescoring all 25 answers per option, which is what makes the sweep tractable.
      const base = totals.slice();
      for (const p of mapping[q][sample[q]]) base[p - 1] -= 1;

      let first = -1;
      let pivotal = false;
      for (let o = 0; o < OPTIONS_PER_QUESTION; o += 1) {
        const trial = base.slice();
        for (const p of mapping[q][o]) trial[p - 1] += 1;
        const w = winnerFromTotals(trial);
        if (first === -1) first = w;
        else if (w !== first) {
          pivotal = true;
          break;
        }
      }
      if (pivotal) hits.set(q, (hits.get(q) ?? 0) + 1);
    }
  }

  for (const [q, n] of hits) hits.set(q, n / samples);
  return hits;
}

/**
 * Static discriminating power, used only to break ties in pivotality: how many distinct
 * profile-impact signatures a question's four options have. A question whose options all
 * do the same thing tells you nothing no matter when you ask it.
 */
export const discrimination: readonly number[] = Object.freeze(
  Array.from({ length: QUESTION_COUNT }, (_, q) => {
    const signatures = new Set(mapping[q].map((profiles) => [...profiles].sort((a, b) => a - b).join(",")));
    return signatures.size;
  }),
);
