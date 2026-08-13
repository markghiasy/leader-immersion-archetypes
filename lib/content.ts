/**
 * Archetype copy layer. Presentation only — nothing here may influence scoring.
 */
import contentJson from "@/inputs/archetype-content.json";
import { PROFILE_COUNT } from "./scoring";

export type Archetype = {
  profile: number;
  name: string;
  essence: string;
  description: string;
  exemplar: string;
  strengths: string[];
  watchouts: string[];
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
