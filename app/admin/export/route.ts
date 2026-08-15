import { archetypeName } from "@/lib/content";
import { adminResponses } from "@/lib/queries";
import { scorecardUrl } from "@/lib/env";
import { buildQuery, csvRow, parseAdminFilters, type AdminSearchParams } from "@/lib/admin-filters";

/** CSV of the current filter. Sits under /admin so proxy.ts Basic Auth covers it. */
export const dynamic = "force-dynamic";

const MAX_ROWS = 20_000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params: AdminSearchParams = Object.fromEntries(url.searchParams.entries());
  const filters = parseAdminFilters(params);

  const { rows } = await adminResponses(filters, MAX_ROWS, 0);

  const header = csvRow([
    "result_id",
    // The whole URL, not just the id. The follow-up is a mail merge sent by hand, and
    // rebuilding this from an id in a spreadsheet formula is a step to get wrong at 9pm.
    "scorecard_url",
    "first_name",
    "last_name",
    "email",
    "mobile",
    "company",
    "archetype_number",
    "archetype",
    "source",
    "event_slug",
    "team_id",
    "invited_by",
    "invited_by_archetype_number",
    "invited_by_archetype",
    "completed_at",
  ]);

  const body = rows.map((row) =>
    csvRow([
      row.id,
      scorecardUrl(row.id),
      row.firstName,
      row.lastName,
      row.email,
      row.mobile,
      row.company,
      row.profile,
      archetypeName(row.profile),
      row.teamId !== null ? "invite" : row.eventSlug ?? "direct",
      row.eventSlug,
      // team_id groups a team unambiguously; invited_by alone is a first name and collides.
      row.teamId,
      row.teamOwnerName,
      row.ownerProfile,
      row.ownerProfile !== null ? archetypeName(row.ownerProfile) : null,
      row.createdAt.toISOString(),
    ]),
  );

  const csv = [header, ...body].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = buildQuery(filters).replace(/[?&=]/g, "-");

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leader-archetype-responses-${stamp}${suffix}.csv"`,
      "cache-control": "no-store",
    },
  });
}
