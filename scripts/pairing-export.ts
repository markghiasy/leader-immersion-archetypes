import "./load-env";
import { writeFileSync } from "node:fs";
import { adminResponses } from "@/lib/queries";
import { archetypeName } from "@/lib/content";
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

/**
 * The links in this file are the whole point of it, and this script runs on a laptop whose
 * .env.local points BASE_URL at a LAN address for phone testing. Without this guard the
 * first run produced http://192.168.1.61:3000/r/... in every row — links to a machine that
 * will not be running when the recipient opens the email, and nothing about the CSV would
 * have looked wrong.
 *
 * Refuse rather than guess. A public https origin is the only thing that can be correct here.
 */
function publicOrigin(): string {
  const url = process.env.BASE_URL?.trim();
  if (url && url.startsWith("https://")) return url.replace(/\/+$/, "");
  console.error(
    [
      "",
      `BASE_URL is ${url ? `"${url}"` : "not set"} — that is not a public origin.`,
      "",
      "Every row in this file carries a scorecard link, so a local or missing BASE_URL would",
      "send people to an address that does not exist. Re-run with the live origin:",
      "",
      "  BASE_URL=https://leader-immersion-archetype.aaronsansoni.com \\",
      "    npx tsx scripts/pairing-export.ts melbourne-aug",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/** RFC4180: quote everything, double any embedded quote. The prose here contains commas. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function main() {
  const origin = publicOrigin();
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
      archetypeName(row.profile), `${origin}/r/${row.id}`,
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
  console.log(`  links point at  : ${origin}`);
  console.log("");
  console.log("The guidance is UNRATIFIED. Read it before sending.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
