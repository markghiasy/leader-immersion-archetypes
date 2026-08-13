/**
 * Drizzle schema — standard Postgres only, no host-specific types.
 * RDS, Aurora, a container or a managed provider all take this file unchanged.
 */
import {
  pgTable,
  bigserial,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Covers the roster read: team_id = ? order by seq desc.
    index("responses_team_id_seq_idx").on(t.teamId, t.seq),
    index("responses_seq_idx").on(t.seq),
    index("responses_event_slug_idx").on(t.eventSlug),
  ],
);

export type Event = typeof events.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Response = typeof responses.$inferSelect;
export type NewResponse = typeof responses.$inferInsert;
