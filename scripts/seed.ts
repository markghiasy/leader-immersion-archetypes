import "./load-env";
import { DEMO_EVENT_SLUG, seedDemoData } from "@/lib/seed-data";
import { baseUrl, scorecardUrl, teamInviteUrl } from "@/lib/env";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  const { ownerResultId, ownerTeamSlug, log } = await seedDemoData();
  for (const line of log) console.log(line);

  console.log("\nTry these:");
  console.log(`  Event entry : ${baseUrl()}/q/${DEMO_EVENT_SLUG}`);
  console.log(`  Scorecard   : ${scorecardUrl(ownerResultId)}`);
  console.log(`  Invite link : ${teamInviteUrl(ownerTeamSlug)}`);
  console.log(`  Admin       : ${baseUrl()}/admin`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
