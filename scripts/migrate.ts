import "./load-env";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { normaliseConnection } from "../lib/db";

/**
 * Applies drizzle/*.sql to DATABASE_URL. Plain Postgres DDL against a plain Postgres
 * driver — run it against RDS, a container, or anything else that speaks the protocol.
 *
 * Run this as a one-off task (ECS RunTask / a bastion / CI) BEFORE the new version of the
 * app starts serving. It is not run automatically on boot, deliberately: several tasks
 * booting at once must not race each other applying migrations.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  // Same TLS handling as the app — see the note in lib/db.ts on why sslmode is stripped.
  const { connectionString: dsn, ssl } = normaliseConnection(connectionString);
  const pool = new Pool({ connectionString: dsn, ssl, max: 1 });

  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
