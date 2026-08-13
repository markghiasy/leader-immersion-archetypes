/**
 * THE DRIVER SEAM — the only file in the app that knows how we reach Postgres.
 *
 * Standard `node-postgres` against standard Postgres. There is nothing here specific to
 * any host: the same code runs against Amazon RDS, Aurora Serverless v2, a Postgres
 * container, or a managed provider, and it is what the AWS handover is built on.
 * See docs/AWS-DEPLOYMENT.md.
 *
 * Everything else in the app imports `getDb()` and speaks plain Drizzle.
 */
import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let cached: Db | null = null;
let pool: Pool | null = null;

/**
 * TLS for the connection.
 *
 * - `DATABASE_CA_CERT` (the PEM itself) → verify the server against it. This is the
 *   correct setting for RDS: download the regional bundle from
 *   https://truststore.pki.rds.amazonaws.com/ and put its contents in the variable.
 * - `sslmode=verify-full`/`verify-ca` in the URL → verify against the system trust store.
 * - any other `sslmode` except `disable` → encrypt without verifying, which is what hosted
 *   providers that rotate their own certificates expect.
 * - no `sslmode` at all → no TLS, for a local Postgres container.
 */
function sslConfig(sslMode: string | null): PoolConfig["ssl"] {
  const ca = process.env.DATABASE_CA_CERT?.trim();
  if (ca) return { ca, rejectUnauthorized: true };
  if (sslMode === "verify-full" || sslMode === "verify-ca") return { rejectUnauthorized: true };
  if (sslMode && sslMode !== "disable") return { rejectUnauthorized: false };
  return undefined;
}

/**
 * Take TLS entirely out of the connection string and decide it here.
 *
 * `pg` currently treats `sslmode=require` as `verify-full`, and warns that in pg 9 it will
 * flip to libpq semantics — the opposite meaning. Leaving that to the URL means the same
 * DATABASE_URL behaves differently after a routine dependency bump, which is exactly the
 * kind of surprise a handover should not carry. So we read `sslmode`, strip it, and pass
 * an explicit `ssl` object that means what it says on every version.
 */
export function normaliseConnection(connectionString: string): { connectionString: string; ssl: PoolConfig["ssl"] } {
  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode");
    url.searchParams.delete("sslmode");
    url.searchParams.delete("uselibpqcompat");
    return { connectionString: url.toString(), ssl: sslConfig(sslMode) };
  } catch {
    // Not a parseable URL (a libpq key=value DSN, say) — leave it exactly as given.
    return { connectionString, ssl: sslConfig(null) };
  }
}

function createDb(): Db {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }

  const connection = normaliseConnection(connectionString);

  pool = new Pool({
    connectionString: connection.connectionString,
    ssl: connection.ssl,
    // Small by design. On a long-lived server (ECS/EC2) a handful of connections serves a
    // very high request rate; on serverless, each instance holds its own pool, so keeping
    // this low is what stops a burst from exhausting max_connections.
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS ?? 10_000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 10_000),
  });

  // A pool that never logs its errors will fail silently when the database restarts.
  pool.on("error", (error) => {
    console.error("[db] idle client error", error.message);
  });

  return drizzle(pool, { schema });
}

/** Lazily created and reused for the lifetime of the process (or serverless instance). */
export function getDb(): Db {
  if (!cached) cached = createDb();
  return cached;
}

/** Test seam: swap in an in-process Postgres (PGlite) without touching app code. */
export function setDbForTesting(db: Db | null): void {
  cached = db;
}

/** Liveness probe for the load balancer health check. */
export async function pingDb(): Promise<void> {
  const { sql } = await import("drizzle-orm");
  await getDb().execute(sql`select 1`);
}

/** Graceful shutdown, so in-flight queries finish when ECS sends SIGTERM. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  cached = null;
}
