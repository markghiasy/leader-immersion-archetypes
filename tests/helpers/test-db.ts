import { readFileSync } from "node:fs";
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

  const migration = readFileSync(path.join(process.cwd(), "drizzle/0000_init.sql"), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await db.execute(sql.raw(trimmed));
  }

  setDbForTesting(db as unknown as Db);
  return { db, client };
}

export async function resetTestDb(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  await db.execute(sql.raw("truncate table responses, teams, events restart identity cascade"));
  clearCaches();
  resetRateLimits();
}

export function teardownTestDb() {
  setDbForTesting(null);
}
