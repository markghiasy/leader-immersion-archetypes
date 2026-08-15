/**
 * All data access. Plain Drizzle, standard Postgres, no driver specifics (see lib/db.ts).
 */
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "./db";
import { events, interviewDrafts, responses, teams, type Response } from "./schema";
import { publicId } from "./ids";
import type { Contact } from "./validation";
import type { ScoreResult } from "./scoring";
import type { IntakeMode } from "./interview/contract";

/* ------------------------------------------------------------------ *
 * Hot-path caches
 *
 * Event slugs and team slugs are effectively immutable once created, so a short-lived
 * per-instance cache keeps the burst path (1000 scans, then a wave of submits) off the
 * database without introducing any external store.
 * ------------------------------------------------------------------ */

const EVENT_TTL_MS = 60_000;
let eventCache: { slugs: Set<string>; expiresAt: number } | null = null;

/** Known event slugs. Unknown slugs are stored as null on the response, per spec. */
export async function knownEventSlugs(): Promise<Set<string>> {
  const now = Date.now();
  if (eventCache && eventCache.expiresAt > now) return eventCache.slugs;
  const rows = await getDb().select({ slug: events.slug }).from(events);
  const slugs = new Set(rows.map((r) => r.slug));
  eventCache = { slugs, expiresAt: now + EVENT_TTL_MS };
  return slugs;
}

const teamIdCache = new Map<string, number>();

/** Resolve a public invite slug to its internal team id. Cached; teams never change. */
export async function teamIdBySlug(slug: string): Promise<number | null> {
  const cached = teamIdCache.get(slug);
  if (cached !== undefined) return cached;
  const [row] = await getDb().select({ id: teams.id }).from(teams).where(eq(teams.slug, slug)).limit(1);
  if (!row) return null;
  if (teamIdCache.size > 5000) teamIdCache.clear();
  teamIdCache.set(slug, row.id);
  return row.id;
}

export function clearCaches(): void {
  eventCache = null;
  teamIdCache.clear();
}

/* ------------------------------------------------------------------ *
 * Team invite landing
 * ------------------------------------------------------------------ */

export type TeamOwner = { teamSlug: string; ownerFirstName: string };

export async function teamOwnerBySlug(slug: string): Promise<TeamOwner | null> {
  const [row] = await getDb()
    .select({ teamSlug: teams.slug, ownerFirstName: responses.firstName })
    .from(teams)
    .innerJoin(responses, eq(responses.id, teams.ownerResponseId))
    .where(eq(teams.slug, slug))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ *
 * The write path — exactly once, at submit
 * ------------------------------------------------------------------ */

export type CreateCompletionInput = {
  contact: Contact;
  answers: number[];
  scored: ScoreResult;
  eventSlug: string | null;
  teamId: number | null;
  /**
   * How the answers were gathered. Required rather than defaulted: the column exists so a
   * shifted archetype distribution can be attributed to the instrument or to the cohort,
   * and a silent fallback to 'tap' would destroy exactly that. The 499-response baseline
   * was gathered on the form.
   */
  intakeMode: IntakeMode;
};

/**
 * Insert the response and create its own team in ONE real transaction. Either both rows
 * land or neither does; an abandoned quiz writes nothing at all.
 */
export async function createCompletion(input: CreateCompletionInput): Promise<{ resultId: string; teamSlug: string }> {
  const db = getDb();
  const resultId = publicId();
  const teamSlug = publicId();

  await db.transaction(async (tx) => {
    await tx.insert(responses).values({
      id: resultId,
      eventSlug: input.eventSlug,
      firstName: input.contact.firstName,
      lastName: input.contact.lastName,
      email: input.contact.email,
      mobile: input.contact.mobile,
      company: input.contact.company,
      answers: input.answers,
      totals: input.scored.totals,
      profile: input.scored.profile,
      teamId: input.teamId,
      intakeMode: input.intakeMode,
    });
    await tx.insert(teams).values({ slug: teamSlug, ownerResponseId: resultId });
  });

  teamIdCache.delete(teamSlug);
  return { resultId, teamSlug };
}

export type CreateInterviewCompletionInput = CreateCompletionInput & {
  /** The draft this completion consumes. Deleted in the same transaction as the write. */
  draftId: string;
};

/**
 * The interview's completion path: consume the draft and create its response + team in ONE
 * transaction, or do nothing if the draft is already gone.
 *
 * `createCompletion` above and `deleteDraft` used to be two separate statements, called back
 * to back from `lib/interview/session.ts`. A crash or a lost response between them left the
 * response (and its team) written but the draft still sitting there looking unfinished — so
 * the client's retry, or a concurrent retry of the same final turn, would run the completion
 * a second time: a second response row and a second team for one person, silently double-
 * counting them in the archetype distribution.
 *
 * Folding the delete into the same transaction as the inserts closes that window. The delete
 * runs first and its `RETURNING` clause is the guard: if no row comes back, some other
 * attempt already consumed this draft, and this call does nothing rather than create a
 * duplicate. The caller cannot recover the original resultId from here — the draft, and any
 * link back to it, is gone by design once an interview completes — so a second attempt is
 * reported the same way an unrecognised draft is, not as a fresh completion.
 */
export async function createInterviewCompletion(
  input: CreateInterviewCompletionInput,
): Promise<{ resultId: string; teamSlug: string } | null> {
  const db = getDb();
  const resultId = publicId();
  const teamSlug = publicId();

  const result = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(interviewDrafts)
      .where(eq(interviewDrafts.id, input.draftId))
      .returning({ id: interviewDrafts.id });

    if (deleted.length === 0) return null;

    await tx.insert(responses).values({
      id: resultId,
      eventSlug: input.eventSlug,
      firstName: input.contact.firstName,
      lastName: input.contact.lastName,
      email: input.contact.email,
      mobile: input.contact.mobile,
      company: input.contact.company,
      answers: input.answers,
      totals: input.scored.totals,
      profile: input.scored.profile,
      teamId: input.teamId,
      intakeMode: input.intakeMode,
    });
    await tx.insert(teams).values({ slug: teamSlug, ownerResponseId: resultId });

    return { resultId, teamSlug };
  });

  if (result) teamIdCache.delete(teamSlug);
  return result;
}

/* ------------------------------------------------------------------ *
 * Scorecard — two indexed reads, nothing else on the hot path
 * ------------------------------------------------------------------ */

export type Scorecard = {
  response: Response;
  ownTeamId: number;
  ownTeamSlug: string;
  joinedOwnerFirstName: string | null;
};

export async function getScorecard(resultId: string): Promise<Scorecard | null> {
  const ownTeam = alias(teams, "own_team");
  const joinedTeam = alias(teams, "joined_team");
  const joinedOwner = alias(responses, "joined_owner");

  const [row] = await getDb()
    .select({
      response: responses,
      ownTeamId: ownTeam.id,
      ownTeamSlug: ownTeam.slug,
      joinedOwnerFirstName: joinedOwner.firstName,
    })
    .from(responses)
    .leftJoin(ownTeam, eq(ownTeam.ownerResponseId, responses.id))
    .leftJoin(joinedTeam, eq(joinedTeam.id, responses.teamId))
    .leftJoin(joinedOwner, eq(joinedOwner.id, joinedTeam.ownerResponseId))
    .where(eq(responses.id, resultId))
    .limit(1);

  if (!row || row.ownTeamId === null || row.ownTeamSlug === null) return null;

  return {
    response: row.response,
    ownTeamId: row.ownTeamId,
    ownTeamSlug: row.ownTeamSlug,
    joinedOwnerFirstName: row.joinedOwnerFirstName,
  };
}

export type RosterMember = { firstName: string; lastName: string; profile: number };

type RosterRow = { firstName: string; lastName: string; email: string; profile: number; seq: number };

export async function getRoster(teamId: number): Promise<RosterMember[]> {
  const rows = await getDb()
    .select({
      firstName: responses.firstName,
      lastName: responses.lastName,
      email: responses.email,
      profile: responses.profile,
      seq: responses.seq,
    })
    .from(responses)
    .where(eq(responses.teamId, teamId))
    .orderBy(desc(responses.seq));

  return dedupeRoster(rows);
}

/**
 * Newest first, one row per person: if somebody takes the quiz twice through the same
 * link, the roster shows their latest result only. Contact details never leave this
 * function — the roster is names and archetypes only.
 */
export function dedupeRoster(rows: RosterRow[]): RosterMember[] {
  const sorted = [...rows].sort((a, b) => b.seq - a.seq);
  const seen = new Set<string>();
  const out: RosterMember[] = [];
  for (const row of sorted) {
    const key = row.email.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ firstName: row.firstName, lastName: row.lastName, profile: row.profile });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */

export type AdminFilters = {
  event?: string | null;
  profile?: number | null;
  source?: "event" | "invite" | null;
};

export type AdminRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  mobile: string;
  company: string | null;
  profile: number;
  eventSlug: string | null;
  teamId: number | null;
  teamOwnerName: string | null;
  /** The inviter's archetype, or null for someone who did not arrive through an invite. */
  ownerProfile: number | null;
  createdAt: Date;
};

function adminWhere(filters: AdminFilters) {
  const clauses = [];
  if (filters.event) clauses.push(eq(responses.eventSlug, filters.event));
  if (filters.profile) clauses.push(eq(responses.profile, filters.profile));
  if (filters.source === "invite") clauses.push(sql`${responses.teamId} is not null`);
  if (filters.source === "event") clauses.push(sql`${responses.teamId} is null`);
  return clauses.length ? and(...clauses) : undefined;
}

export async function adminResponses(
  filters: AdminFilters,
  limit: number,
  offset: number,
): Promise<{ rows: AdminRow[]; total: number }> {
  const db = getDb();
  const joinedTeam = alias(teams, "joined_team");
  const joinedOwner = alias(responses, "joined_owner");
  const where = adminWhere(filters);

  const rows = await db
    .select({
      id: responses.id,
      firstName: responses.firstName,
      lastName: responses.lastName,
      email: responses.email,
      mobile: responses.mobile,
      company: responses.company,
      profile: responses.profile,
      eventSlug: responses.eventSlug,
      teamId: responses.teamId,
      ownerFirstName: joinedOwner.firstName,
      ownerLastName: joinedOwner.lastName,
      // The inviter's own archetype. Carried so the export answers "who works with whom,
      // and as what" in one row — the pairing follow-up is built off this, and joining a
      // member back to their inviter by NAME breaks the moment two inviters share one.
      ownerProfile: joinedOwner.profile,
      createdAt: responses.createdAt,
    })
    .from(responses)
    .leftJoin(joinedTeam, eq(joinedTeam.id, responses.teamId))
    .leftJoin(joinedOwner, eq(joinedOwner.id, joinedTeam.ownerResponseId))
    .where(where)
    .orderBy(desc(responses.seq))
    .limit(limit)
    .offset(offset);

  const [{ value: total }] = await db
    .select({ value: count() })
    .from(responses)
    .where(where);

  return {
    rows: rows.map(({ ownerFirstName, ownerLastName, ...rest }) => ({
      ...rest,
      teamOwnerName: ownerFirstName ? `${ownerFirstName} ${ownerLastName ?? ""}`.trim() : null,
    })),
    total,
  };
}

export async function adminDistribution(filters: AdminFilters): Promise<Map<number, number>> {
  const rows = await getDb()
    .select({ profile: responses.profile, value: count() })
    .from(responses)
    .where(adminWhere(filters))
    .groupBy(responses.profile);
  return new Map(rows.map((r) => [r.profile, r.value]));
}

export async function adminEvents(): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ slug: responses.eventSlug })
    .from(responses)
    .orderBy(asc(responses.eventSlug));
  return rows.map((r) => r.slug).filter((s): s is string => Boolean(s));
}

export type AdminTeamRow = { ownerName: string; memberCount: number; createdAt: Date; slug: string };

export async function adminTeams(sort: "members" | "recent"): Promise<AdminTeamRow[]> {
  const db = getDb();
  const owner = alias(responses, "owner");
  const member = alias(responses, "member");

  const rows = await db
    .select({
      slug: teams.slug,
      ownerFirstName: owner.firstName,
      ownerLastName: owner.lastName,
      createdAt: teams.createdAt,
      memberCount: count(member.id),
    })
    .from(teams)
    .innerJoin(owner, eq(owner.id, teams.ownerResponseId))
    .leftJoin(member, eq(member.teamId, teams.id))
    .groupBy(teams.id, teams.slug, owner.firstName, owner.lastName, teams.createdAt)
    .orderBy(sort === "members" ? desc(count(member.id)) : desc(teams.createdAt));

  return rows.map((r) => ({
    slug: r.slug,
    ownerName: `${r.ownerFirstName} ${r.ownerLastName}`.trim(),
    memberCount: r.memberCount,
    createdAt: r.createdAt,
  }));
}

/* ------------------------------------------------------------------ *
 * Email
 * ------------------------------------------------------------------ */

export async function responseForEmail(resultId: string): Promise<Response | null> {
  const [row] = await getDb().select().from(responses).where(eq(responses.id, resultId)).limit(1);
  return row ?? null;
}

export async function seedEvent(slug: string, name: string): Promise<void> {
  await getDb().insert(events).values({ slug, name }).onConflictDoNothing();
  eventCache = null;
}

export async function eventsBySlugs(slugs: string[]) {
  if (slugs.length === 0) return [];
  return getDb().select().from(events).where(inArray(events.slug, slugs));
}
