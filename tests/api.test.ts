import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, teardownTestDb } from "./helpers/test-db";
import { POST } from "@/app/api/submit/route";
import { GET as exportRoute } from "@/app/admin/export/route";
import { interviewDrafts, responses, teams } from "@/lib/schema";
import { adminResponses, createInterviewCompletion, getRoster, getScorecard, seedEvent, teamOwnerBySlug, dedupeRoster } from "@/lib/queries";
import { optionIndexById, QUESTION_COUNT, questions, score, testVectors } from "@/lib/scoring";

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

describe("createInterviewCompletion — the interview's atomic completion", () => {
  /** A draft with all 25 answers already settled, as `finish()` hands them in. */
  async function seedDraft(id: string) {
    await harness.db.insert(interviewDrafts).values({
      id,
      firstName: "Alex",
      lastName: "Nguyen",
      email: "alex@example.com",
      mobile: "0412 345 678",
      company: "Northwind",
      answers: VECTOR_ANSWERS,
      turn: QUESTION_COUNT,
    });
  }

  function completionInput(draftId: string) {
    return {
      draftId,
      contact: contact(),
      answers: VECTOR_ANSWERS,
      scored: score(VECTOR_ANSWERS),
      eventSlug: null,
      teamId: null,
      intakeMode: "interview" as const,
    };
  }

  it("writes the response and team, and consumes the draft, in one transaction", async () => {
    await seedDraft("draft0000000a");

    const result = await createInterviewCompletion(completionInput("draft0000000a"));

    expect(result).not.toBeNull();
    expect(await harness.db.select().from(responses)).toHaveLength(1);
    expect(await harness.db.select().from(teams)).toHaveLength(1);
    expect(await harness.db.select().from(interviewDrafts)).toHaveLength(0);
  });

  it("does not mint a second scorecard when the same draft is completed twice", async () => {
    // Reproduces the retry a lost response (or a crash between the old separate
    // createCompletion/deleteDraft statements) used to trigger: a second call for a draft
    // that has already been consumed must be a no-op, not a second response and team.
    await seedDraft("draft0000000b");
    const input = completionInput("draft0000000b");

    const first = await createInterviewCompletion(input);
    const second = await createInterviewCompletion(input);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await harness.db.select().from(responses)).toHaveLength(1);
    expect(await harness.db.select().from(teams)).toHaveLength(1);
  });

  it("does nothing for a draft id that was never there", async () => {
    const result = await createInterviewCompletion(completionInput("no-such-draft"));

    expect(result).toBeNull();
    expect(await harness.db.select().from(responses)).toHaveLength(0);
    expect(await harness.db.select().from(teams)).toHaveLength(0);
  });
});

describe("scorecard reads", () => {
  it("returns null for an unknown result id", async () => {
    expect(await getScorecard("zzzzzzzzzzzzzz")).toBeNull();
  });
});

describe("adminResponses — the inviter's archetype, for the pairing follow-up", () => {
  /**
   * The export is the input to a "how to work with each other" follow-up sent after the
   * event. That needs BOTH sides of each pairing on one row. Joining a member back to their
   * inviter by first name breaks the moment two inviters share one, so the inviter's own
   * archetype is carried explicitly.
   */
  async function completeOne(draftId: string, over: { email: string; answers: number[]; teamId: number | null }) {
    await harness.db.insert(interviewDrafts).values({
      id: draftId,
      firstName: "Alex",
      lastName: "Nguyen",
      email: over.email,
      mobile: "0412 345 678",
      answers: over.answers,
      turn: QUESTION_COUNT,
    });
    return createInterviewCompletion({
      draftId,
      contact: contact({ email: over.email }),
      answers: over.answers,
      scored: score(over.answers),
      eventSlug: null,
      teamId: over.teamId,
      intakeMode: "interview" as const,
    });
  }

  it("carries the inviter's archetype onto the invited member's row", async () => {
    const owner = await completeOne("draftowner001", {
      email: "owner@example.com",
      answers: VECTOR_ANSWERS,
      teamId: null,
    });
    expect(owner).not.toBeNull();

    const [team] = await harness.db.select().from(teams);
    // A different answer set, so the member's archetype is distinguishable from the owner's.
    const memberAnswers = VECTOR_ANSWERS.map((a, i) => (i % 3 === 0 ? (a + 1) % 4 : a));
    await completeOne("draftmember01", {
      email: "member@example.com",
      answers: memberAnswers,
      teamId: team.id,
    });

    const { rows } = await adminResponses({}, 50, 0);
    const member = rows.find((r) => r.email === "member@example.com");
    const ownerRow = rows.find((r) => r.email === "owner@example.com");

    expect(member?.teamId).toBe(team.id);
    // The whole point: the member's row states who invited them AND what that person is.
    expect(member?.ownerProfile).toBe(ownerRow?.profile);
    expect(member?.teamOwnerName).toBe("Alex Nguyen");
  });

  it("leaves the inviter's archetype null for someone who did not arrive through an invite", async () => {
    await completeOne("draftdirect01", { email: "direct@example.com", answers: VECTOR_ANSWERS, teamId: null });

    const { rows } = await adminResponses({}, 50, 0);
    expect(rows.find((r) => r.email === "direct@example.com")?.ownerProfile).toBeNull();
  });
});

describe("the admin export round trip", () => {
  /**
   * The follow-up after the event is a mail merge sent by hand: export, merge, send. That
   * makes this CSV the deliverable, not a debugging aid — so it is tested the way it will be
   * used, from a completed interview all the way to a parsed row with a working link in it.
   */
  it("carries a usable scorecard URL on the production origin", async () => {
    const previous = process.env.BASE_URL;
    process.env.BASE_URL = "https://leader-immersion-archetype.aaronsansoni.com";

    try {
      await harness.db.insert(interviewDrafts).values({
        id: "draftexport01",
        firstName: "Dana",
        lastName: "Reed",
        email: "dana@example.com",
        mobile: "0412 000 111",
        answers: VECTOR_ANSWERS,
        turn: QUESTION_COUNT,
      });
      const completed = await createInterviewCompletion({
        draftId: "draftexport01",
        contact: contact({ email: "dana@example.com" }),
        answers: VECTOR_ANSWERS,
        scored: score(VECTOR_ANSWERS),
        eventSlug: null,
        teamId: null,
        intakeMode: "interview" as const,
      });
      expect(completed).not.toBeNull();

      const csv = await (await exportRoute(new Request("http://localhost:3000/admin/export"))).text();
      const [head, first] = csv.split("\r\n");
      const cols = head.split(",");
      const cells = first.split(",");
      const at = (name: string) => cells[cols.indexOf(name)];

      // The row a mail merge reads: who they are, where their scorecard lives, what it says.
      expect(at("email")).toBe("dana@example.com");
      expect(at("scorecard_url")).toBe(
        `https://leader-immersion-archetype.aaronsansoni.com/r/${completed!.resultId}`,
      );
      // And that URL is the same one the app itself serves, not a second spelling of it.
      expect(at("scorecard_url").endsWith(`/r/${at("result_id")}`)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
    }
  });
});
