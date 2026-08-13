import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, teardownTestDb } from "./helpers/test-db";
import { POST } from "@/app/api/submit/route";
import { responses, teams } from "@/lib/schema";
import { getRoster, getScorecard, seedEvent, teamOwnerBySlug, dedupeRoster } from "@/lib/queries";
import { optionIndexById, questions, score, testVectors } from "@/lib/scoring";

let harness: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  harness = await createTestDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(async () => {
  await resetTestDb(harness.db);
});

/** The first replay vector, expressed as option indexes — a realistic answer set. */
const VECTOR_ANSWERS = questions.map((question, qi) => optionIndexById(qi, testVectors[0].answers[question.id]));

function contact(overrides: Partial<Record<string, string>> = {}) {
  return {
    firstName: "Alex",
    lastName: "Nguyen",
    email: "alex@example.com",
    mobile: "0412 345 678",
    company: "Northwind",
    ...overrides,
  };
}

async function submit(body: unknown) {
  const request = new Request("http://localhost:3000/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
    body: JSON.stringify(body),
  });
  const response = await POST(request);
  const json = (await response.json()) as { resultId?: string; error?: string; fields?: Record<string, string> };
  return { status: response.status, json };
}

describe("POST /api/submit — happy path", () => {
  it("scores server-side, stores the response and creates the taker's own team", async () => {
    await seedEvent("melbourne-aug", "Melbourne — August");

    const { status, json } = await submit({ contact: contact(), answers: VECTOR_ANSWERS, event: "melbourne-aug" });

    expect(status).toBe(201);
    expect(json.resultId).toMatch(/^[A-Za-z0-9_-]{14}$/);

    const [row] = await harness.db.select().from(responses).where(eq(responses.id, json.resultId!));
    expect(row.eventSlug).toBe("melbourne-aug");
    expect(row.teamId).toBeNull();
    expect(row.answers).toEqual(VECTOR_ANSWERS);

    // The stored score is the frozen scoring function's, not anything the client sent.
    const expected = score(VECTOR_ANSWERS);
    expect(row.totals).toEqual(expected.totals);
    expect(row.profile).toBe(expected.profile);
    expect(row.profile).toBe(testVectors[0].expected_archetype);

    const [team] = await harness.db.select().from(teams).where(eq(teams.ownerResponseId, json.resultId!));
    expect(team.slug).toMatch(/^[A-Za-z0-9_-]{14}$/);
  });

  it("stores an unknown event slug as no event, but still records the completion", async () => {
    const { status, json } = await submit({ contact: contact(), answers: VECTOR_ANSWERS, event: "not-a-real-event" });
    expect(status).toBe(201);
    const [row] = await harness.db.select().from(responses).where(eq(responses.id, json.resultId!));
    expect(row.eventSlug).toBeNull();
  });
});

describe("POST /api/submit — team attribution (the growth loop)", () => {
  async function createOwner() {
    const { json } = await submit({ contact: contact({ email: "owner@example.com" }), answers: VECTOR_ANSWERS });
    const card = await getScorecard(json.resultId!);
    return { resultId: json.resultId!, teamSlug: card!.ownTeamSlug, teamId: card!.ownTeamId };
  }

  it("attributes a completion made through a team link back to the sharer", async () => {
    const owner = await createOwner();

    const { status, json } = await submit({
      contact: contact({ firstName: "Priya", lastName: "Shah", email: "priya@example.com" }),
      answers: VECTOR_ANSWERS,
      teamSlug: owner.teamSlug,
    });
    expect(status).toBe(201);

    const [row] = await harness.db.select().from(responses).where(eq(responses.id, json.resultId!));
    expect(row.teamId).toBe(owner.teamId);

    // The teammate appears on the sharer's roster...
    const roster = await getRoster(owner.teamId);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ firstName: "Priya", lastName: "Shah" });

    // ...and gets a scorecard and invite link of their own — a fresh tree, one hop only.
    const teammateCard = await getScorecard(json.resultId!);
    expect(teammateCard!.ownTeamSlug).not.toBe(owner.teamSlug);
    expect(teammateCard!.joinedOwnerFirstName).toBe("Alex");
    expect(await getRoster(teammateCard!.ownTeamId)).toEqual([]);
  });

  it("still records a completion when the invite link is not recognised, without attribution", async () => {
    const { status, json } = await submit({
      contact: contact({ email: "stranger@example.com" }),
      answers: VECTOR_ANSWERS,
      teamSlug: "aaaaaaaaaaaaaa",
    });
    expect(status).toBe(201);
    const [row] = await harness.db.select().from(responses).where(eq(responses.id, json.resultId!));
    expect(row.teamId).toBeNull();
  });

  it("resolves the invite landing page's owner name from the slug", async () => {
    const owner = await createOwner();
    expect(await teamOwnerBySlug(owner.teamSlug)).toEqual({ teamSlug: owner.teamSlug, ownerFirstName: "Alex" });
    expect(await teamOwnerBySlug("aaaaaaaaaaaaaa")).toBeNull();
  });

  it("shows each teammate once, newest result first, when someone retakes the quiz", async () => {
    const owner = await createOwner();

    const first = await submit({
      contact: contact({ firstName: "Jo", lastName: "Baker", email: "JO@example.com" }),
      answers: VECTOR_ANSWERS,
      teamSlug: owner.teamSlug,
    });
    const retakeAnswers = questions.map((question, qi) => optionIndexById(qi, testVectors[2].answers[question.id]));
    const second = await submit({
      contact: contact({ firstName: "Jo", lastName: "Baker", email: "jo@example.com" }),
      answers: retakeAnswers,
      teamSlug: owner.teamSlug,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    // Same person, two completions, one roster line — showing the later result.
    const roster = await getRoster(owner.teamId);
    expect(roster).toHaveLength(1);
    expect(roster[0].profile).toBe(testVectors[2].expected_archetype);
  });

  it("never puts contact details on the roster", async () => {
    const owner = await createOwner();
    await submit({
      contact: contact({ firstName: "Priya", email: "priya@example.com" }),
      answers: VECTOR_ANSWERS,
      teamSlug: owner.teamSlug,
    });
    const roster = await getRoster(owner.teamId);
    expect(Object.keys(roster[0])).toEqual(["firstName", "lastName", "profile"]);
  });
});

describe("dedupeRoster", () => {
  it("keeps the newest row per email address, case-insensitively", () => {
    const rows = [
      { firstName: "Jo", lastName: "B", email: "jo@example.com", profile: 1, seq: 1 },
      { firstName: "Jo", lastName: "B", email: "JO@Example.com ", profile: 5, seq: 9 },
      { firstName: "Sam", lastName: "T", email: "sam@example.com", profile: 3, seq: 5 },
    ];
    expect(dedupeRoster(rows)).toEqual([
      { firstName: "Jo", lastName: "B", profile: 5 },
      { firstName: "Sam", lastName: "T", profile: 3 },
    ]);
  });
});

describe("POST /api/submit — validation", () => {
  it("rejects a malformed email", async () => {
    const { status, json } = await submit({ contact: contact({ email: "not-an-email" }), answers: VECTOR_ANSWERS });
    expect(status).toBe(400);
    expect(json.fields?.email).toBeTruthy();
  });

  it("rejects a missing first name", async () => {
    const { status, json } = await submit({ contact: contact({ firstName: "  " }), answers: VECTOR_ANSWERS });
    expect(status).toBe(400);
    expect(json.fields?.["firstName"]).toBeTruthy();
  });

  it("rejects an incomplete answer set", async () => {
    const { status } = await submit({ contact: contact(), answers: VECTOR_ANSWERS.slice(0, 24) });
    expect(status).toBe(400);
  });

  it("rejects an out-of-range option index", async () => {
    const answers = [...VECTOR_ANSWERS];
    answers[7] = 4;
    const { status } = await submit({ contact: contact(), answers });
    expect(status).toBe(400);
  });

  it("rejects a body that is not JSON", async () => {
    const request = new Request("http://localhost:3000/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect((await POST(request)).status).toBe(400);
  });

  it("writes nothing at all when validation fails", async () => {
    await submit({ contact: contact({ email: "nope" }), answers: VECTOR_ANSWERS });
    expect(await harness.db.select().from(responses)).toHaveLength(0);
    expect(await harness.db.select().from(teams)).toHaveLength(0);
  });
});

describe("scorecard reads", () => {
  it("returns null for an unknown result id", async () => {
    expect(await getScorecard("zzzzzzzzzzzzzz")).toBeNull();
  });
});
