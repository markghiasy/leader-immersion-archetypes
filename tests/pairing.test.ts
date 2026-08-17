import { describe, expect, it } from "vitest";
import { allPairings, archetypeKey, DEFAULT_PILLAR, pairingFor, PILLARS, titleCase, trimBoilerplate } from "@/lib/pairing";
import { allArchetypes } from "@/lib/content";

/**
 * The pairwise set is the input to a follow-up sent by hand to a room of business owners
 * about named colleagues. Coverage is therefore not a nicety: a gap becomes a person who
 * receives an email with a blank where their guidance should be.
 */
describe("pairwise guidance", () => {
  it("covers every leader x target x pillar combination", () => {
    expect(allPairings()).toHaveLength(8 * 8 * PILLARS.length);
  });

  it("maps every archetype profile the app can produce", () => {
    for (const a of allArchetypes) {
      expect(archetypeKey(a.profile), `profile ${a.profile} (${a.name})`).toBeTruthy();
    }
  });

  it("resolves a record for every pair of profiles at the default pillar", () => {
    for (const leader of allArchetypes) {
      for (const target of allArchetypes) {
        const rec = pairingFor(leader.profile, target.profile);
        expect(rec, `${leader.name} -> ${target.name}`).not.toBeNull();
        // The substance fields are the two that are unique per pairing; an empty one would
        // render as a blank section rather than an obvious failure.
        expect(rec!.dynamic.length).toBeGreaterThan(40);
        expect(rec!.lead_them_by.length).toBeGreaterThan(40);
      }
    }
  });

  it("returns a different record for the same pair at a different pillar", () => {
    const team = pairingFor(1, 3, "team");
    const empire = pairingFor(1, 3, "empire");
    expect(team!.record_id).not.toBe(empire!.record_id);
    expect(team!.lead_them_by).not.toBe(empire!.lead_them_by);
  });

  it("treats a same-archetype pairing as a real record, not an error", () => {
    const rec = pairingFor(1, 1);
    expect(rec).not.toBeNull();
    expect(rec!.fit_tier).toBe("Shared style / shared blind spot");
  });

  it("defaults to the team pillar", () => {
    expect(pairingFor(2, 5)!.record_id).toBe(`influencer__${DEFAULT_PILLAR}__play_maker`);
  });

  it("returns null for a profile that does not exist rather than throwing", () => {
    expect(pairingFor(99, 1)).toBeNull();
    expect(pairingFor(1, 0)).toBeNull();
  });
});

describe("merge helpers", () => {
  it("title-cases names people typed themselves", () => {
    expect(titleCase("mark")).toBe("Mark");
    expect(titleCase("MARK GHIASY")).toBe("Mark Ghiasy");
    expect(titleCase("  india   stewart evans ")).toBe("India Stewart Evans");
  });

  it("preserves the punctuation inside real names", () => {
    expect(titleCase("o'brien")).toBe("O'Brien");
    expect(titleCase("SMITH-JONES")).toBe("Smith-Jones");
  });

  it("removes the per-pillar boilerplate that closes 224 of the 256 records", () => {
    const rec = pairingFor(1, 3, "team")!;
    expect(rec.dynamic).toMatch(/At the TEAM level, the leader must use their own edge/);
    const trimmed = trimBoilerplate(rec.dynamic);
    expect(trimmed).not.toMatch(/must use their own edge/);
    // The per-pair substance must survive: both contributions are still described.
    expect(trimmed).toMatch(/Innovator/);
    expect(trimmed).toMatch(/Guide/);
    expect(trimmed.endsWith(".")).toBe(true);
  });

  it("leaves the same-archetype records alone — their closing line is real content", () => {
    const rec = pairingFor(1, 1, "team")!;
    expect(rec.dynamic).toMatch(/opportunity is fluency/);
    expect(trimBoilerplate(rec.dynamic)).toMatch(/opportunity is fluency/);
  });

  it("strips the boilerplate from every record that carries it, and only those", () => {
    let stripped = 0;
    for (const r of allPairings()) {
      const t = trimBoilerplate(r.dynamic);
      if (t !== r.dynamic) stripped += 1;
      expect(t).not.toMatch(/must use their own edge/);
      expect(t.length).toBeGreaterThan(60);
    }
    expect(stripped).toBe(224);
  });
});
