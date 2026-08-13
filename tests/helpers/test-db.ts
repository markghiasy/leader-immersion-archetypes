import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/schema";
import { setDbForTesting, type Db } from "@/lib/db";
import { clearCaches } from "@/lib/queries";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * Real Postgres, in process (PGlite), created from the same drizzle-kit migration that
 * ships to production. Swapping the driver here is the whole point of lib/db.ts — it is
 * also the standing proof that the app is not coupled to any one Postgres host.
 */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  // Every migration, in order — not just the first. Hardcoding 0000 meant a new migration
  // was invisible to the tests, which fail on a missing table rather than a wrong one.
  const dir = path.join(process.cwd(), "drizzle");
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    const sqlText = readFileSync(path.join(dir, file), "utf8");
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await db.execute(sql.raw(trimmed));
    }
  }

  setDbForTesting(db as unknown as Db);
  return { db, client };
}

export async function resetTestDb(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  await db.execute(sql.raw("truncate table responses, teams, events, interview_drafts restart identity cascade"));
  clearCaches();
  resetRateLimits();
}

export function teardownTestDb() {
  setDbForTesting(null);
}
