/**
 * Archetype copy layer. Presentation only — nothing here may influence scoring.
 */
import contentJson from "@/inputs/archetype-content.json";
import { PROFILE_COUNT } from "./scoring";

/**
 * `essence` through `watchouts` are the original copy the 499-response baseline was gathered
 * against. Everything below them is merged from the Empire Archetype Leadership Knowledge
 * Base v1.0 (Aaron Sansoni Group, 16 Aug 2026), which is **unratified** — it is a work in
 * progress, not signed-off methodology.
 *
 * `essence` itself was REWRITTEN from that pack. The original wording is kept verbatim in
 * `essence_legacy` so the change is a one-line revert rather than an archaeology exercise.
 * The difference is not stylistic: ours described a personality ("motivates and directs"),
 * the pack states a contribution ("builds people, trust, culture"). The pairwise guidance is
 * written in the second vocabulary, so mixing them makes the report contradict itself — which
 * is the whole reason for taking one and not both.
 */
export type Archetype = {
  profile: number;
  name: string;
  essence: string;
  /** The pre-v2 wording, retained so the essence rewrite can be reverted without a lookup. */
  essence_legacy: string;
  description: string;
  exemplar: string;
  strengths: string[];
  watchouts: string[];
  /** What this archetype does under pressure — its predictable trap. */
  pressure_shadow: string;
  /** What this archetype looks like at its best; the direction, not the label. */
  mature_expression: string;
  /** The specific antidote to the pressure shadow. */
  counter_move: string;
  /** What this archetype needs from the people around it. */
  needs: string[];
  /** How trust is built with this archetype. */
  trust: string;
  /** Six axes, 1-5. The only quantitative shape we hold for an archetype. */
  dimensions: { pace: number; structure: number; people: number; data: number; risk: number; vision: number };
};

const archetypes = contentJson.archetypes as Archetype[];

if (archetypes.length !== PROFILE_COUNT) {
  throw new Error(`archetype-content.json must describe ${PROFILE_COUNT} profiles, found ${archetypes.length}`);
}

const byProfile = new Map<number, Archetype>(archetypes.map((a) => [a.profile, a]));

for (let p = 1; p <= PROFILE_COUNT; p += 1) {
  if (!byProfile.has(p)) throw new Error(`archetype-content.json is missing profile ${p}`);
}

export function archetypeFor(profile: number): Archetype {
  const archetype = byProfile.get(profile);
  if (!archetype) throw new Error(`Unknown profile ${profile}`);
  return archetype;
}

/** The user-facing title, e.g. "1. The Innovator". The number only ever appears here. */
export function archetypeTitle(profile: number): string {
  return `${profile}. ${archetypeFor(profile).name}`;
}

export function archetypeName(profile: number): string {
  return archetypeFor(profile).name;
}

export const allArchetypes: readonly Archetype[] = Object.freeze([...archetypes].sort((a, b) => a.profile - b.profile));

/** "3 Innovators, 2 Guardians" — pluralised on the archetype name, in profile order. */
export function mixSummary(profiles: number[]): string {
  const counts = new Map<number, number>();
  for (const p of profiles) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([profile, count]) => {
      const name = archetypeName(profile).replace(/^The /, "");
      return `${count} ${count === 1 ? name : pluralise(name)}`;
    })
    .join(", ");
}

function pluralise(name: string): string {
  if (/(s|x|z|ch|sh)$/i.test(name)) return `${name}es`;
  return `${name}s`;
}
