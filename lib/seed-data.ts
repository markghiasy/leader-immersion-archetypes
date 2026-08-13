import { createCompletion, seedEvent, teamIdBySlug } from "./queries";
import { optionIndexById, questions, score, testVectors } from "./scoring";
import { archetypeTitle } from "./content";

/**
 * Demo data: one event, one team with two members who joined by invite, and two more
 * people who came in through the event. Enough for /admin and a roster to render
 * immediately after a fresh install.
 *
 * It goes through the same write path as a live completion — no direct inserts — so the
 * seed also acts as a smoke test of the transaction.
 */

export const DEMO_EVENT_SLUG = "melbourne-aug";
export const DEMO_EVENT_NAME = "Melbourne — August";

const PEOPLE = [
  { firstName: "Dana", lastName: "Whitfield", email: "dana@example.com", mobile: "0400 111 222", company: "Northwind" },
  { firstName: "Priya", lastName: "Shah", email: "priya@example.com", mobile: "0400 333 444", company: "Northwind" },
  { firstName: "Tom", lastName: "Ellery", email: "tom@example.com", mobile: "0400 555 666", company: null },
  { firstName: "Bec", lastName: "Nolan", email: "bec@example.com", mobile: "0400 777 888", company: "Harbour Co" },
  { firstName: "Sam", lastName: "Okoro", email: "sam@example.com", mobile: "0400 999 000", company: null },
];

/** Real answer sets taken from the schema's replay vectors, so the archetypes vary. */
function answersFromVector(index: number): number[] {
  const vector = testVectors[index % testVectors.length];
  return questions.map((question, qi) => optionIndexById(qi, vector.answers[question.id]));
}

export type SeedResult = { ownerResultId: string; ownerTeamSlug: string; log: string[] };

export async function seedDemoData(): Promise<SeedResult> {
  const log: string[] = [];

  await seedEvent(DEMO_EVENT_SLUG, DEMO_EVENT_NAME);
  log.push(`Event created: /q/${DEMO_EVENT_SLUG}`);

  const [owner, ...rest] = PEOPLE;
  const ownerAnswers = answersFromVector(0);
  const ownerScore = score(ownerAnswers);
  const ownerResult = await createCompletion({
    contact: { ...owner, company: owner.company ?? null },
    answers: ownerAnswers,
    scored: ownerScore,
    eventSlug: DEMO_EVENT_SLUG,
    teamId: null,
    intakeMode: "tap",
  });
  log.push(`Owner: ${owner.firstName} — ${archetypeTitle(ownerScore.profile)}`);

  const teamId = await teamIdBySlug(ownerResult.teamSlug);

  for (const [index, person] of rest.entries()) {
    const answers = answersFromVector(index + 1);
    const scored = score(answers);
    // The first two join the owner's team; the rest arrive through the event directly.
    const viaTeam = index < 2;
    await createCompletion({
      contact: { ...person, company: person.company ?? null },
      answers,
      scored,
      eventSlug: viaTeam ? null : DEMO_EVENT_SLUG,
      teamId: viaTeam ? teamId : null,
      intakeMode: "tap",
    });
    log.push(`  ${person.firstName} — ${archetypeTitle(scored.profile)}${viaTeam ? " (via invite)" : ""}`);
  }

  return { ownerResultId: ownerResult.resultId, ownerTeamSlug: ownerResult.teamSlug, log };
}
