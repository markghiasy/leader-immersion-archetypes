import { PROFILE_COUNT } from "./scoring";
import type { AdminFilters } from "./queries";

export const PAGE_SIZE = 50;

export type AdminSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function parseAdminFilters(params: AdminSearchParams): AdminFilters {
  const event = first(params.event);
  const profileRaw = first(params.profile);
  const profile = profileRaw ? Number(profileRaw) : null;
  const source = first(params.source);
  return {
    event: event && event !== "all" ? event : null,
    profile: profile && Number.isInteger(profile) && profile >= 1 && profile <= PROFILE_COUNT ? profile : null,
    source: source === "event" || source === "invite" ? source : null,
  };
}

export function parsePage(params: AdminSearchParams): number {
  const raw = Number(first(params.page) ?? 1);
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

export function parseTeamSort(params: AdminSearchParams): "members" | "recent" {
  return first(params.teams) === "recent" ? "recent" : "members";
}

/** Rebuild the query string, dropping empty values, so links stay clean and shareable. */
export function buildQuery(filters: AdminFilters, extra: Record<string, string | number | undefined> = {}): string {
  const query = new URLSearchParams();
  if (filters.event) query.set("event", filters.event);
  if (filters.profile) query.set("profile", String(filters.profile));
  if (filters.source) query.set("source", filters.source);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === "" ) continue;
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

/** RFC 4180 quoting. Leading =/+/-/@ are prefixed so spreadsheets do not treat them as formulas. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}
