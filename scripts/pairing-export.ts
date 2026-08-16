import "./load-env";
import { writeFileSync } from "node:fs";
import { adminResponses } from "@/lib/queries";
import { archetypeName } from "@/lib/content";
import { scorecardUrl } from "@/lib/env";
import { DEFAULT_PILLAR, pairingFor, type Pillar } from "@/lib/pairing";

/**
 * Builds the mail-merge input for the post-event follow-up: one row per person, carrying
 * their scorecard link AND the guidance for working with whoever invited them.
 *
 * A SEPARATE script rather than more columns on /admin/export, on purpose. The admin export
 * is the operational artefact people pull during and after an event and it needs to stay
 * small enough to read; this one carries paragraphs and exists for a single send. Coupling
 * them would make the everyday export unusable to serve an occasional one.
 *
 *   npx tsx scripts/pairing-export.ts [event-slug] [pillar]
 *
 * ⚠️ The guidance is UNRATIFIED content (Empire Archetype Leadership Knowledge Base v1.0).
 * Read it before it goes to a room of business owners about named colleagues.
 */
const EVENT = process.argv[2] ?? null;
const PILLAR = (process.argv[3] as Pillar) ?? DEFAULT_PILLAR;
const OUT = `pairing-merge-${EVENT ?? "all"}-${PILLAR}.csv`;

/** RFC4180: quote everything, double any embedded quote. The prose here contains commas. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function main() {
  const { rows } = await adminResponses(EVENT ? { event: EVENT } : {}, 20_000, 0);

  const header = [
    "first_name", "last_name", "email", "company",
    "archetype", "scorecard_url",
    "invited_by", "invited_by_archetype",
    "pillar", "fit_tier", "fit_tier_meaning",
    "dynamic", "lead_them_by", "watch_out",
  ];

  let paired = 0;
  let unpaired = 0;

  const body = rows.map((row) => {
    // Someone who arrived without an invite has no counterpart, so no pairing exists. They
    // still belong in the file — they get the scorecard half of the email — with the pairing
    // columns empty, so the merge can branch rather than the person being silently dropped.
    const pairing = row.ownerProfile !== null ? pairingFor(row.ownerProfile, row.profile, PILLAR) : null;
    if (pairing) paired += 1;
    else unpaired += 1;

    return [
      row.firstName, row.lastName, row.email, row.company ?? "",
      archetypeName(row.profile), scorecardUrl(row.id),
      row.teamOwnerName ?? "", row.ownerProfile !== null ? archetypeName(row.ownerProfile) : "",
      pairing ? PILLAR : "",
      pairing?.fit_tier ?? "", pairing?.fit_tier_meaning ?? "",
      pairing?.dynamic ?? "", pairing?.lead_them_by ?? "", pairing?.watch_out ?? "",
    ].map(cell).join(",");
  });

  writeFileSync(OUT, [header.map(cell).join(","), ...body].join("\r\n"));

  console.log(`Wrote ${OUT}`);
  console.log(`  rows            : ${rows.length}`);
  console.log(`  with a pairing  : ${paired}   (invited, so we know both archetypes)`);
  console.log(`  without         : ${unpaired}   (arrived direct — scorecard only)`);
  console.log(`  pillar          : ${PILLAR}`);
  console.log("");
  console.log("The guidance is UNRATIFIED. Read it before sending.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
