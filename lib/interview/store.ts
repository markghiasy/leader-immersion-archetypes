/**
 * DRAFT PERSISTENCE for the conversational intake.
 *
 * The form holds its state in React for three minutes and writes once. A 16-20 minute
 * interview cannot: a dropped connection, a locked phone or a wandering thumb in a venue
 * loses the lot. So the draft is written on every turn and lives here, in its own
 * disposable tier — see the note on `interviewDrafts` in lib/schema.ts for why it is
 * deliberately kept apart from `responses`.
 *
 * This module owns two translations that exist nowhere else:
 *
 *   1. null ↔ -1 for unsettled answers. The contract says `(number | null)[]`; a Postgres
 *      `integer[]` says -1. Nothing outside this file should ever see a -1.
 *   2. The TTL. `sweepExpiredDrafts` is periodic, so an expired draft may still be sitting
 *      in the table when someone resumes it. Reads and writes therefore apply the cutoff
 *      themselves: a draft past its TTL is gone the moment it expires, not the moment the
 *      sweeper next runs. Otherwise the answer to "is my draft still there?" would depend
 *      on cron timing, which is not an answer anyone can act on.
 *
 * All timestamps come from the database (`now()`), never from the app clock — several
 * instances write the same table and skew between them would make the TTL approximate.
 */
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { publicId } from "@/lib/ids";
import { QUESTION_COUNT } from "@/lib/scoring";
import { interviewDrafts, type InterviewDraftRow } from "@/lib/schema";
import { INTERVIEW_LIMITS, type InterviewDraft } from "./contract";

/* ------------------------------------------------------------------ *
 * The -1 sentinel
 * ------------------------------------------------------------------ */

/**
 * Stored in `answers` where the contract has null. Exported for tests and for anyone
 * reading the table by hand; application code should use the encoded/decoded forms below.
 * Safe as a sentinel because a real answer is 0..3 and lib/interview/controller.ts rejects
 * out-of-range values rather than clamping them, so -1 can never arrive as an answer.
 */
export const ANSWER_UNSET = -1;

function encodeAnswers(answers: (number | null)[]): number[] {
  // A short array would silently shift every question index once it came back out, so this
  // is a hard error rather than a pad: the caller has a bug and should hear about it now.
  if (answers.length !== QUESTION_COUNT) {
    throw new Error(`A draft holds exactly ${QUESTION_COUNT} answers, received ${answers.length}`);
  }
  return answers.map((v) => (v === null ? ANSWER_UNSET : v));
}

function decodeAnswers(stored: number[]): (number | null)[] {
  if (stored.length !== QUESTION_COUNT) {
    throw new Error(`Draft answers are corrupt: expected ${QUESTION_COUNT} entries, found ${stored.length}`);
  }
  return stored.map((v) => (v === ANSWER_UNSET ? null : v));
}

/** Row → the contract's shape. The row's flat contact columns become the nested object. */
function toDraft(row: InterviewDraftRow): InterviewDraft {
  return {
    id: row.id,
    eventSlug: row.eventSlug,
    teamSlug: row.teamSlug,
    contact: {
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      mobile: row.mobile,
      company: row.company,
    },
    answers: decodeAnswers(row.answers),
    transcript: row.transcript,
    provenance: row.provenance,
    turn: row.turn,
    lastTurnKey: row.lastTurnKey,
    lastTurnResponse: row.lastTurnResponse,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The instant before which a draft is considered abandoned. Evaluated by Postgres, and
 * `make_interval` takes the hours as a bound parameter — no string-built SQL.
 */
function ttlCutoff() {
  return sql`now() - make_interval(hours => ${INTERVIEW_LIMITS.draftTtlHours})`;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export type CreateDraftInput = {
  contact: InterviewDraft["contact"];
  eventSlug: string | null;
  teamSlug: string | null;
};

/**
 * Start an interview. The id is a nanoid(14) like every other public id in the app: the
 * client holds it for the whole session, so it has to be unguessable — it is the only thing
 * standing between a stranger and someone else's half-finished answers and contact details.
 */
export async function createDraft(input: CreateDraftInput): Promise<InterviewDraft> {
  const [row] = await getDb()
    .insert(interviewDrafts)
    .values({
      id: publicId(),
      eventSlug: input.eventSlug,
      teamSlug: input.teamSlug,
      firstName: input.contact.firstName,
      lastName: input.contact.lastName,
      email: input.contact.email,
      mobile: input.contact.mobile,
      company: input.contact.company,
      answers: Array.from({ length: QUESTION_COUNT }, () => ANSWER_UNSET),
      transcript: [],
      provenance: [],
      turn: 0,
    })
    .returning();

  return toDraft(row);
}

/** Null for an id that never existed, was completed, or has passed its TTL — all the same
 * thing to the caller: there is nothing to resume. */
export async function getDraft(id: string): Promise<InterviewDraft | null> {
  const [row] = await getDb()
    .select()
    .from(interviewDrafts)
    .where(and(eq(interviewDrafts.id, id), gt(interviewDrafts.updatedAt, ttlCutoff())))
    .limit(1);

  return row ? toDraft(row) : null;
}

/**
 * The fields a turn can move. Everything else about a draft — who it belongs to, which event
 * or invite it arrived on — is fixed at creation and never patched.
 */
export type DraftPatch = Pick<
  InterviewDraft,
  "answers" | "transcript" | "provenance" | "turn" | "lastTurnKey" | "lastTurnResponse"
>;

/**
 * Write the whole conversational state back, last-write-wins. Full replacement rather than
 * a merge because the caller already holds the entire draft in memory for the turn it just
 * processed, and merging two versions of a transcript is a problem nobody needs: one person,
 * one device, one turn at a time.
 *
 * Returns null if the draft has since expired or been deleted, so a caller can tell the
 * person their session lapsed instead of reporting a save that never happened.
 */
export async function saveDraft(id: string, patch: DraftPatch): Promise<InterviewDraft | null> {
  const [row] = await getDb()
    .update(interviewDrafts)
    .set({
      answers: encodeAnswers(patch.answers),
      transcript: patch.transcript,
      provenance: patch.provenance,
      turn: patch.turn,
      lastTurnKey: patch.lastTurnKey,
      lastTurnResponse: patch.lastTurnResponse,
      updatedAt: sql`now()`,
    })
    .where(and(eq(interviewDrafts.id, id), gt(interviewDrafts.updatedAt, ttlCutoff())))
    .returning();

  return row ? toDraft(row) : null;
}

/**
 * Drop a draft. Called once the response row is written: the permanent record exists, so
 * the working copy of somebody's contact details and half-formed answers should not.
 * Idempotent — deleting an id that has already gone is not an error.
 */
export async function deleteDraft(id: string): Promise<void> {
  await getDb().delete(interviewDrafts).where(eq(interviewDrafts.id, id));
}

/**
 * Remove abandoned drafts and report how many went. Most interviews are abandoned rather
 * than completed — that is the nature of a 20-minute instrument in a room — and each one
 * holds a name, an email and a mobile, so this is a privacy chore, not housekeeping.
 *
 * Counting via `returning()` rather than a driver rowCount keeps the function honest on
 * both drivers we run (node-postgres in production, PGlite in the tests).
 */
export async function sweepExpiredDrafts(): Promise<number> {
  const rows = await getDb()
    .delete(interviewDrafts)
    .where(lt(interviewDrafts.updatedAt, ttlCutoff()))
    .returning({ id: interviewDrafts.id });

  return rows.length;
}
