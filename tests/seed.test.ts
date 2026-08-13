import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb, teardownTestDb } from "./helpers/test-db";
import { seedDemoData, DEMO_EVENT_SLUG } from "@/lib/seed-data";
import { adminDistribution, adminResponses, adminTeams, getRoster, getScorecard } from "@/lib/queries";
import { responses } from "@/lib/schema";

let harness: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(() => teardownTestDb());
beforeEach(async () => {
  await resetTestDb(harness.db);
});

describe("seed script", () => {
  it("leaves /admin and a roster with something to render", async () => {
    const { ownerResultId } = await seedDemoData();

    expect(await harness.db.select().from(responses)).toHaveLength(5);

    const card = await getScorecard(ownerResultId);
    expect(card).not.toBeNull();
    expect(card!.response.eventSlug).toBe(DEMO_EVENT_SLUG);

    // The owner's scorecard shows a populated team straight away.
    const roster = await getRoster(card!.ownTeamId);
    expect(roster).toHaveLength(2);

    const { rows, total } = await adminResponses({}, 50, 0);
    expect(total).toBe(5);
    expect(rows.filter((r) => r.teamId !== null)).toHaveLength(2);
    expect(rows.filter((r) => r.eventSlug === DEMO_EVENT_SLUG)).toHaveLength(3);

    const distribution = await adminDistribution({});
    expect([...distribution.values()].reduce((a, b) => a + b, 0)).toBe(5);

    const teams = await adminTeams("members");
    expect(teams).toHaveLength(5);
    expect(teams[0].memberCount).toBe(2);
  });

  it("filters by source and archetype the way /admin does", async () => {
    await seedDemoData();

    const invites = await adminResponses({ source: "invite" }, 50, 0);
    expect(invites.total).toBe(2);
    expect(invites.rows.every((r) => r.teamOwnerName === "Dana Whitfield")).toBe(true);

    const direct = await adminResponses({ source: "event" }, 50, 0);
    expect(direct.total).toBe(3);

    const profile = invites.rows[0].profile;
    const byArchetype = await adminResponses({ profile }, 50, 0);
    expect(byArchetype.rows.every((r) => r.profile === profile)).toBe(true);
  });
});
