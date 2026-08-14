# What production actually is

Written for anyone testing or auditing this app. None of the below can be derived from the
source, and several findings that look correct on a laptop are wrong about production.

Companion documents: `docs/AWS-DEPLOYMENT.md` (how the target host is built), `README.md`
(how to run it locally).

## There are two runtimes, and the target is not the current one

| | Interim (today) | **Target — authoritative** |
|---|---|---|
| Host | Vercel serverless | AWS, long-lived container (ECS Fargate / App Runner) |
| Process model | N ephemeral instances, autoscaled | 2 long-lived tasks |
| Node | 24.x | **22** (`Dockerfile`, `.nvmrc`, `engines`) |
| Region | `iad1` (US East) | Chosen at build time — expected `ap-southeast-2` |
| Database | Managed Postgres | RDS Postgres, private subnet |
| Deploys | `vercel --prod` from one laptop | Image build + task deploy |

**Test against the target, not the interim host.** The two differ in exactly the areas
load and concurrency testing probes, so a result gathered against one does not transfer to
the other.

### The faithful local target is the container, not `next dev`

```bash
docker build -t leader-archetype-quiz .
docker run -p 3000:3000 --env-file .env.production leader-archetype-quiz
```

That image is the Monday artifact. `npm run dev` is convenient for iterating on logic, but
it is a different process model, a different Node major, and an unminified build — do not
draw performance or concurrency conclusions from it.

## Environment variables actually set in production

Five, and only five:

| Variable | Set? | Consequence |
|---|---|---|
| `DATABASE_URL` | yes | — |
| `BASE_URL` | yes | Baked into invite links, QR codes, email buttons at render time |
| `ADMIN_USER` / `ADMIN_PASS` | yes | `/admin` is Basic Auth; unset would fail closed with 503 |
| `ANTHROPIC_API_KEY` | yes | Extraction only. The tap-form quiz never calls a model |
| `RESEND_API_KEY` / `EMAIL_FROM` | **no** | **"Email me my scorecard" is HIDDEN in production.** Do not test or sign off this feature locally — it is not live |
| `DATABASE_CA_CERT` | **no** | `sslmode=require` encrypts but does **not verify** the certificate. Known posture; must be set against RDS |
| `DB_POOL_MAX` / `DB_POOL_IDLE_MS` / `DB_CONNECT_TIMEOUT_MS` | no | Defaults: 5 / 10000 / 10000 |

**Pending before Monday:** the Anthropic key rotates from a personal key to a business
account key. Rate-limit headroom is a property of the key, not the app — see below.

### `BASE_URL` is gated at boot

`instrumentation.ts` refuses to start the server when `BASE_URL` (or `VERCEL_URL`) and
`DATABASE_URL` are missing in production, and `baseUrl()` throws rather than returning its
localhost fallback. Before this gate existed, an unset `BASE_URL` was silent: every
scorecard URL, invite link, QR target and email button would point at
`http://localhost:3000` while the app rendered perfectly and health checks passed.

Note the failure shape, because it decides how the load balancer must be configured: a
container failing the gate **still binds its port**. Next logs `Failed to prepare server`
and serves `500` to everything. Measured: **TCP connect succeeds; `/api/health` and every
page return 500.** Probe over HTTP, never TCP.

## Findings that do NOT transfer from a laptop

Treat all of these as unverified until measured against the deployed container.

1. **Rate limiting is in-memory per process** (`lib/rate-limit.ts`, which says so itself).
   One local process is one bucket, so limits behave exactly as written. On the interim
   serverless host the real ceiling is the configured limit × the number of warm
   instances. On the AWS target it is × 2 tasks. Local results overstate the protection
   everywhere.
2. **`/api/interview/turn` is keyed on `draftId`, not on IP.** Every new draft receives a
   fresh turn budget, and every turn is a model call. This is the cost-amplification
   surface; the IP-based limit on `/api/interview/start` is the only thing bounding it,
   and it is deliberately generous because a venue shares one NAT.
3. **Connection pooling.** `DB_POOL_MAX` is per process. Five locally; five per task or
   per instance in production, scaling with load against the database's own
   `max_connections`.
4. **Latency.** ~3.1s median extraction unloaded; ~6.5s median under real concurrency.
   A laptop will only ever show the first number.
5. **429s.** A burst of 40 concurrent turns produced zero 429s on a key with 5000 req/min.
   A lower-tier key will produce 429s that are a property of the key, not a defect in the
   app. Re-baseline after the business-key rotation.

## Measured, do not re-derive

- Synthetic cohort of 15 simulated people against the live API: **15/15 completed
  conversationally, 0 fell back to the tap form, 0 re-asks, 25–27 turns each.** Archetype
  agreement 15/15; mean 0.27 wrong answers of 25.
- The failure mode is **contentless** answers, not short ones. Terse three-to-eight-word
  replies produced zero re-asks. "Plan it out first" extracts cleanly; "with enthusiasm"
  correctly abstains. Do not "fix" terseness.
- One wrong answer in 25 flips the resulting archetype 15.4% of the time. This is why the
  extractor abstains rather than guesses, everywhere.

## Known gaps, already agreed

- **`sweepExpiredDrafts()` has no caller.** Abandoned `interview_drafts` rows retain name,
  email and mobile indefinitely. Needs a scheduled invocation and the TTL cut from 48h to
  ~8h. This is the highest-value backend task outstanding.
- **No preview or staging environment.** Deploys go straight to production, which is also
  why device testing has nowhere safe to run.
- **The interim host is not connected to GitHub.** Merging to `main` deploys nothing; only
  an explicit CLI deploy ships code.
- The narrowing / check-back turn has never been exercised by a human, only synthetically.

## Data note

The production database currently contains **15 synthetic completions** from the cohort
run. They are unmarked — no flag column — and identifiable only by
`cohort.<style>.<n>@example.com` and mobiles `0400 100 00n`. Exclude them from any count,
distribution or export. `scripts/synthetic-cohort.ts` defaults its base URL to production;
pass an explicit base URL to avoid writing there again.
