/**
 * Boot-time configuration gate.
 *
 * Next calls `register()` once per server process, before the first request. Throwing
 * here fails the process rather than letting it serve, which is what we want: the
 * failure modes this catches are silent ones — an unset BASE_URL publishes permanent
 * links pointing at localhost while every page still renders and every health check
 * still passes.
 *
 * Under a container orchestrator this turns a silent misconfiguration into a task that
 * never reaches a healthy state, so the previous version keeps serving.
 */
export async function register(): Promise<void> {
  // Only the Node server needs this; the check reads server-only configuration.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertProductionEnv } = await import("./lib/env");
  assertProductionEnv();
}
