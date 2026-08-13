import Link from "next/link";
import styles from "./admin.module.css";
import { allArchetypes, archetypeName } from "@/lib/content";
import { adminDistribution, adminEvents, adminResponses, adminTeams } from "@/lib/queries";
import { PAGE_SIZE, buildQuery, parseAdminFilters, parsePage, parseTeamSort, type AdminSearchParams } from "@/lib/admin-filters";

/** Server-rendered, plain and fast. Access is enforced by Basic Auth in proxy.ts. */
export const dynamic = "force-dynamic";

export default async function AdminPage({ searchParams }: { searchParams: Promise<AdminSearchParams> }) {
  const params = await searchParams;
  const filters = parseAdminFilters(params);
  const page = parsePage(params);
  const teamSort = parseTeamSort(params);

  const [{ rows, total }, distribution, events, teams] = await Promise.all([
    adminResponses(filters, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    adminDistribution(filters),
    adminEvents(),
    adminTeams(teamSort),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="container container-wide">
      <div className={styles.header}>
        <h1>Responses</h1>
        <a className="button button-secondary" href={`/admin/export${buildQuery(filters)}`}>
          Export CSV
        </a>
      </div>

      <form className={styles.filters} method="get">
        <label>
          Event
          <select name="event" defaultValue={filters.event ?? "all"}>
            <option value="all">All events</option>
            {events.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </label>
        <label>
          Archetype
          <select name="profile" defaultValue={filters.profile ? String(filters.profile) : ""}>
            <option value="">All archetypes</option>
            {allArchetypes.map((a) => (
              <option key={a.profile} value={a.profile}>
                {a.profile}. {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select name="source" defaultValue={filters.source ?? ""}>
            <option value="">All sources</option>
            <option value="event">Event or direct</option>
            <option value="invite">Team invite</option>
          </select>
        </label>
        <button type="submit" className="button">
          Apply
        </button>
        <Link className="button button-secondary" href="/admin">
          Clear
        </Link>
      </form>

      <div className={styles.distribution}>
        {allArchetypes.map((a) => (
          <div key={a.profile} className={styles.stat}>
            <div className={styles.statValue}>{distribution.get(a.profile) ?? 0}</div>
            <div className={styles.statLabel}>
              {a.profile}. {a.name}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Mobile</th>
              <th scope="col">Company</th>
              <th scope="col">Archetype</th>
              <th scope="col">Source</th>
              <th scope="col">Invited by</th>
              <th scope="col">Completed</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No responses match this filter yet.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.firstName} {row.lastName}
                </td>
                <td>{row.email}</td>
                <td>{row.mobile}</td>
                <td>{row.company ?? "—"}</td>
                <td>
                  {row.profile}. {archetypeName(row.profile)}
                </td>
                <td>{sourceLabel(row.teamId, row.eventSlug)}</td>
                <td>{row.teamOwnerName ?? "—"}</td>
                <td>{formatDate(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.pager}>
        <span className="muted">
          {total} response{total === 1 ? "" : "s"} · page {page} of {pageCount}
        </span>
        {page > 1 && (
          <Link className="button button-secondary" href={`/admin${buildQuery(filters, { page: page - 1 })}`}>
            Previous
          </Link>
        )}
        {page < pageCount && (
          <Link className="button button-secondary" href={`/admin${buildQuery(filters, { page: page + 1 })}`}>
            Next
          </Link>
        )}
      </div>

      <div className={styles.sectionHeading}>
        <h2>Teams</h2>
        <Link
          className="small"
          href={`/admin${buildQuery(filters, { teams: teamSort === "members" ? "recent" : "members", page })}`}
        >
          Sort by {teamSort === "members" ? "most recent" : "member count"}
        </Link>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Owner</th>
              <th scope="col">Members</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {teams.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No teams yet.
                </td>
              </tr>
            )}
            {teams.map((team) => (
              <tr key={team.slug}>
                <td>{team.ownerName}</td>
                <td>{team.memberCount}</td>
                <td>{formatDate(team.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function sourceLabel(teamId: number | null, eventSlug: string | null): string {
  if (teamId !== null) return "invite";
  return eventSlug ?? "direct";
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
