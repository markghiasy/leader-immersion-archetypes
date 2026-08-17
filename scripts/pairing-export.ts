import "./load-env";
import { writeFileSync } from "node:fs";
import { getDb } from "@/lib/db";
import { sql } from "drizzle-orm";
import { archetypeName } from "@/lib/content";
import { DEFAULT_PILLAR, pairingFor, titleCase, trimBoilerplate, type Pillar } from "@/lib/pairing";

/**
 * Builds the mail-merge input for the post-event follow-up.
 *
 * ONE ROW PER DIRECTED RELATIONSHIP, not per person. That is the correction that matters:
 * an earlier version emitted one row per person and looked up pairingFor(owner, member),
 * then addressed it to the MEMBER — so someone would have received instructions written for
 * their leader, telling them how to manage themselves. The chairman asked two questions
 * ("how does she manage me", "how do I work with her") and they are two different records.
 *
 * The rule here: THE RECIPIENT IS ALWAYS THE ACTOR. Every row answers "what do YOU do about
 * this other person", so the recipient's archetype is always the leader key.
 *
 * One row per relationship also solves what one-row-per-person could not express: an owner
 * with five people who joined through their link needs five sets of guidance, not one.
 *
 *   BASE_URL=https://… npx tsx scripts/pairing-export.ts [event-slug] [pillar]
 *
 * ⚠️ The guidance is UNRATIFIED content (Empire Archetype Leadership Knowledge Base v1.0).
 * Read it before it goes to a room of business owners about named colleagues.
 */
const EVENT = process.argv[2] ?? null;
const PILLAR = (process.argv[3] as Pillar) ?? DEFAULT_PILLAR;
const OUT = `pairing-merge-${EVENT ?? "all"}-${PILLAR}.csv`;

/**
 * The links in this file are the whole point of it, and this script runs on a laptop whose
 * .env.local points BASE_URL at a LAN address for phone testing. Without this guard the
 * first run produced http://192.168.1.61:3000/r/... in every row — links to a machine that
 * will not be running when the recipient opens the email.
 */
function publicOrigin(): string {
  const url = process.env.BASE_URL?.trim();
  if (url && url.startsWith("https://")) return url.replace(/\/+$/, "");
  console.error(
    `\nBASE_URL is ${url ? `"${url}"` : "not set"} — that is not a public origin.\n\n` +
      "Every row carries a scorecard link. Re-run with the live origin:\n\n" +
      "  BASE_URL=https://leader-immersion-archetype.aaronsansoni.com \\\n" +
      "    npx tsx scripts/pairing-export.ts melbourne-aug\n",
  );
  process.exit(1);
}



/** RFC4180: quote everything, double any embedded quote. The prose here contains commas. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

type Person = { id: string; firstName: string; lastName: string; email: string; company: string | null; profile: number };
type Relationship = { actor: Person; counterpart: Person; relation: "you invited them" | "they invited you" };

async function main() {
  const origin = publicOrigin();
  const db = getDb();

  // Read the relationships directly rather than through adminResponses: that returns the
  // inviter's NAME but not their id or email, and both directions need a full person.
  const { rows } = (await db.execute(sql`
    select
      m.id as member_id, m.first_name as member_first, m.last_name as member_last,
      m.email as member_email, m.company as member_company, m.profile as member_profile,
      o.id as owner_id, o.first_name as owner_first, o.last_name as owner_last,
      o.email as owner_email, o.company as owner_company, o.profile as owner_profile
    from responses m
    join teams t on t.id = m.team_id
    join responses o on o.id = t.owner_response_id
    ${EVENT ? sql`where m.event_slug = ${EVENT} or o.event_slug = ${EVENT}` : sql``}
  `)) as unknown as { rows: Record<string, string | number | null>[] };

  const relationships: Relationship[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const member: Person = {
      id: String(r.member_id), firstName: String(r.member_first), lastName: String(r.member_last),
      email: String(r.member_email), company: r.member_company as string | null, profile: Number(r.member_profile),
    };
    const owner: Person = {
      id: String(r.owner_id), firstName: String(r.owner_first), lastName: String(r.owner_last),
      email: String(r.owner_email), company: r.owner_company as string | null, profile: Number(r.owner_profile),
    };
    // Both directions. Each person is the actor in their own row.
    for (const rel of [
      { actor: member, counterpart: owner, relation: "they invited you" as const },
      { actor: owner, counterpart: member, relation: "you invited them" as const },
    ]) {
      const key = `${rel.actor.id}->${rel.counterpart.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push(rel);
    }
  }

  const header = [
    "recipient_first_name", "recipient_last_name", "recipient_email", "recipient_archetype",
    "recipient_scorecard_url",
    "counterpart_first_name", "counterpart_archetype", "relationship",
    "pillar", "fit_tier", "fit_tier_meaning", "dynamic", "lead_them_by", "watch_out",
  ];

  let missing = 0;
  const body = relationships.map((rel) => {
    const p = pairingFor(rel.actor.profile, rel.counterpart.profile, PILLAR);
    if (!p) missing += 1;
    return [
      titleCase(rel.actor.firstName), titleCase(rel.actor.lastName), rel.actor.email,
      archetypeName(rel.actor.profile), `${origin}/r/${rel.actor.id}`,
      titleCase(rel.counterpart.firstName), archetypeName(rel.counterpart.profile), rel.relation,
      PILLAR, p?.fit_tier ?? "", p?.fit_tier_meaning ?? "",
      p ? trimBoilerplate(p.dynamic) : "", p?.lead_them_by ?? "", p?.watch_out ?? "",
    ].map(cell).join(",");
  });

  writeFileSync(OUT, [header.map(cell).join(","), ...body].join("\r\n"));

  const recipients = new Set(relationships.map((r) => r.actor.email));
  console.log(`Wrote ${OUT}`);
  console.log(`  directed relationships : ${relationships.length}`);
  console.log(`  distinct recipients    : ${recipients.size}`);
  console.log(`  pairings not found     : ${missing}`);
  console.log(`  pillar                 : ${PILLAR}`);
  console.log(`  links point at         : ${origin}`);
  console.log("");
  console.log("Every row is written FROM the recipient's point of view — they are the actor.");
  console.log("The guidance is UNRATIFIED. Read it before sending.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
