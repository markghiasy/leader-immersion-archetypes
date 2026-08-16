/**
 * Pairwise leadership guidance: how one archetype should work with another.
 *
 * A LOOKUP, not a retrieval system. The pack this content came from recommends RAG, vector
 * databases and fine-tuning; none of that applies here. The key space is 8 leaders × 8
 * targets × 4 pillars = 256 records, complete and exhaustively enumerated, addressed by an
 * exact composite key. A hash map answers that in constant time and can never return the
 * wrong record, which semantic search can.
 *
 * ⚠️ The content is UNRATIFIED — Empire Archetype Leadership Knowledge Base v1.0 (Aaron
 * Sansoni Group, 16 Aug 2026), a work in progress rather than signed-off methodology. Nothing
 * here is rendered to an attendee yet; it exists to build the post-event follow-up.
 */
import data from "@/inputs/pairwise-guidance.json";

export const PILLARS = ["team", "leaders", "business", "empire"] as const;
export type Pillar = (typeof PILLARS)[number];

/**
 * The pillar used when nothing else is known.
 *
 * Every relationship we can currently see is a team roster — someone who took the quiz
 * through a colleague's invite — so `team` is the honest default rather than a placeholder.
 * The other three pillars need an input the interview does not collect: at what level these
 * two people actually work together. Adding one question would unlock the remaining 192
 * records, and that is the cheapest depth available here.
 */
export const DEFAULT_PILLAR: Pillar = "team";

export type PairingRecord = {
  record_id: string;
  leader_archetype: string;
  target_archetype: string;
  pillar: string;
  /** One of five relationship classifications, e.g. "Productive tension". */
  fit_tier?: string;
  fit_tier_meaning?: string;
  /** Unique per pairing (256/256 distinct) — the substance. */
  dynamic: string;
  /** Unique per pairing (256/256 distinct) — the substance. */
  lead_them_by: string;
  /** 31 distinct values; meaningful, but shared across some pairings. */
  watch_out: string;
  /** 64 distinct. Supporting material rather than a headline. */
  communicate?: string;
  /** 32 distinct. Supporting material rather than a headline. */
  motivate?: string;
  /** 64 distinct. Supporting material rather than a headline. */
  trait_to_borrow?: string;
};

const BY_NUMBER = data.archetype_by_number as Record<string, string>;
const RECORDS = data.records as PairingRecord[];

const INDEX = new Map<string, PairingRecord>(RECORDS.map((r) => [r.record_id, r]));

/** `profile` as stored on a response (1-8) → the pack's canonical key. */
export function archetypeKey(profile: number): string | null {
  return BY_NUMBER[String(profile)] ?? null;
}

/**
 * Guidance for `leader` working with `target`, both as stored profile numbers.
 *
 * Returns null rather than throwing: a missing record must never be able to break an export
 * or an email. Same-archetype pairings are real records, not an error — the pack classifies
 * them as "Shared style / shared blind spot", which is often the most useful thing to know.
 */
export function pairingFor(
  leaderProfile: number,
  targetProfile: number,
  pillar: Pillar = DEFAULT_PILLAR,
): PairingRecord | null {
  const leader = archetypeKey(leaderProfile);
  const target = archetypeKey(targetProfile);
  if (!leader || !target) return null;
  return INDEX.get(`${leader}__${pillar}__${target}`) ?? null;
}

/** Every record, for validation and for building the follow-up merge. */
export function allPairings(): readonly PairingRecord[] {
  return RECORDS;
}
