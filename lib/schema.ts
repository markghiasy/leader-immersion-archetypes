/**
 * Drizzle schema — standard Postgres only, no host-specific types.
 * RDS, Aurora, a container or a managed provider all take this file unchanged.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
// Type-only, so nothing from the interview (or the Anthropic SDK behind it) is pulled into
// the module drizzle-kit loads. The jsonb columns are typed by the contract rather than by
// a second, drifting definition of the same shapes.
import type { AnswerProvenance, IntakeMode, TranscriptTurn, TurnResponse } from "./interview/contract";

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("events_slug_idx").on(t.slug)],
);

export const teams = pgTable(
  "teams",
  {
    id: serial("id").primaryKey(),
    /** Public invite slug, nanoid(14). Serial ids are never exposed. */
    slug: text("slug").notNull(),
    ownerResponseId: text("owner_response_id")
      .notNull()
      // `AnyPgColumn` breaks the type cycle created by the two tables referencing each
      // other; the callback itself is evaluated lazily, so declaration order is fine.
      .references((): AnyPgColumn => responses.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("teams_slug_idx").on(t.slug),
    // One team per response; also the index behind the scorecard's "my invite link" lookup.
    uniqueIndex("teams_owner_response_id_idx").on(t.ownerResponseId),
  ],
);

export const responses = pgTable(
  "responses",
  {
    /** Public result id, nanoid(14). This is the scorecard URL. */
    id: text("id").primaryKey(),
    /**
     * Internal, monotonic, never exposed. `created_at` alone cannot order two completions
     * that land in the same instant — and inside one transaction now() is identical — so
     * every "newest first" ordering in the app sorts on this instead.
     */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    eventSlug: text("event_slug"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    mobile: text("mobile").notNull(),
    company: text("company"),
    /** 25 zero-based option indexes, 0-3. */
    answers: integer("answers").array().notNull(),
    /** 8 profile counters, index 0 = profile 1. */
    totals: integer("totals").array().notNull(),
    profile: integer("profile").notNull(),
    /** The team this person joined via, null for direct/event entrants. */
    teamId: integer("team_id").references((): AnyPgColumn => teams.id, { onDelete: "set null" }),
    /**
     * How the 25 answers were gathered. Defaulted to 'tap' because every row that existed
     * before the interview shipped was a tap — the 499-response baseline is a tap baseline,
     * and backfilling it as anything else would corrupt the only comparison we have.
     */
    intakeMode: text("intake_mode").$type<IntakeMode>().notNull().default("tap"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Covers the roster read: team_id = ? order by seq desc.
    index("responses_team_id_seq_idx").on(t.teamId, t.seq),
    index("responses_seq_idx").on(t.seq),
    index("responses_event_slug_idx").on(t.eventSlug),
  ],
);

/**
 * In-flight interviews. A DISPOSABLE tier, deliberately kept apart from `responses`:
 *
 *   - a draft is written on every turn, a response exactly once, at the end, in the same
 *     transaction as today. Mixing the two would put a 40-write conversation on the table
 *     that the scorecard, the roster and the admin list all read;
 *   - an abandoned interview must leave nothing behind, so drafts are swept on a TTL
 *     (INTERVIEW_LIMITS.draftTtlHours) and carry no foreign keys into the permanent data.
 *     No FK to `teams` either: the draft holds the invite SLUG it arrived on and resolves
 *     it at completion, so a draft can never block a team row from being removed.
 */
export const interviewDrafts = pgTable(
  "interview_drafts",
  {
    /** nanoid(14), same generator as the public ids. The client holds this for the session. */
    id: text("id").primaryKey(),
    eventSlug: text("event_slug"),
    /** The invite slug the person arrived on, unresolved. See the note above. */
    teamSlug: text("team_slug"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    mobile: text("mobile").notNull(),
    company: text("company"),
    /**
     * 25 option indexes, ALWAYS length 25, where **-1 means the slot is still unsettled**.
     *
     * The contract types this as `(number | null)[]`, but a Postgres `integer[]` cannot
     * express a null element without giving up `not null` on the whole column and inviting
     * a null array — a much worse failure. A sentinel keeps the column shape honest (fixed
     * width, never null) and the null↔-1 translation lives in exactly one place,
     * lib/interview/store.ts. Nothing outside that module should see a -1.
     *
     * -1 is safe as a sentinel because a real answer is 0..OPTIONS_PER_QUESTION-1 and
     * lib/interview/controller.ts rejects out-of-range values rather than clamping them.
     */
    answers: integer("answers").array().notNull(),
    /** TranscriptTurn[] — the exchange in order, for the transcript and for debugging. */
    transcript: jsonb("transcript").$type<TranscriptTurn[]>().notNull().default(sql`'[]'::jsonb`),
    /** AnswerProvenance[] — why each answer is what it is; powers "why did I get this?". */
    provenance: jsonb("provenance").$type<AnswerProvenance[]>().notNull().default(sql`'[]'::jsonb`),
    /** Agent turns issued so far, against INTERVIEW_LIMITS.maxTurns. */
    turn: integer("turn").notNull().default(0),
    /**
     * The client-generated `requestId` of the most recently PROCESSED /api/interview/turn
     * request for this draft (see the TurnRequest field comment), paired with the exact
     * response that request produced. Null until the first turn after start.
     *
     * A turn is atomic — computed fully, then written once — but the RESPONSE can still be
     * lost after that write commits (a radio drop on venue wifi is the documented cause).
     * The client's retry then resends the same requestId it used the first time. Without
     * this pair, the server has already advanced past the question that request answered,
     * so replaying it would silently bind the old reply to the new question. With it, a
     * request whose id matches the one stored here is answered from the stored response
     * instead of being reprocessed — no model call, no state change, no misattribution.
     *
     * Deliberately keyed on the client's id rather than on reply/tapped content: the same
     * person re-asked the same question after an unreadable answer will often type the same
     * unhelpful reply twice in a row, which is a genuine second turn, not a resend, and
     * content-only matching cannot tell the two apart.
     */
    lastTurnKey: text("last_turn_key"),
    lastTurnResponse: jsonb("last_turn_response").$type<TurnResponse>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The sweep is `delete where updated_at < ?`, and it is the only query that scans this
  // table — everything else is a primary-key lookup.
  (t) => [index("interview_drafts_updated_at_idx").on(t.updatedAt)],
);

export type Event = typeof events.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Response = typeof responses.$inferSelect;
export type NewResponse = typeof responses.$inferInsert;
/** Row shape only. The app-facing draft type is InterviewDraft in the interview contract. */
export type InterviewDraftRow = typeof interviewDrafts.$inferSelect;
export type NewInterviewDraftRow = typeof interviewDrafts.$inferInsert;
