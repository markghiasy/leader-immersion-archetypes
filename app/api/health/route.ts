import { NextResponse } from "next/server";
import { pingDb } from "@/lib/db";

/**
 * Health check for the load balancer / ECS container check.
 *
 * Two levels, because they answer different questions:
 *   GET /api/health        — is the process up? Never touches the database, so a database
 *                            blip does not cause the ALB to kill and replace every task.
 *   GET /api/health?deep=1 — can it also reach Postgres? Use this from monitoring, and
 *                            as the readiness gate on a deploy, not as the liveness probe.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.has("deep");

  if (!deep) {
    return NextResponse.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  }

  try {
    await pingDb();
    return NextResponse.json({ status: "ok", database: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[health] database unreachable", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { status: "degraded", database: "unreachable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
