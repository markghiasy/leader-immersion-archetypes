# Hosting this on AWS

Handover notes for IT ops. Written to be read once, top to bottom.

## What this app is, in one paragraph

A Next.js 16 app (Node runtime, no edge functions) with a Postgres database. An attendee
scans a QR code, answers 25 questions, and gets a permanent scorecard at an unguessable
URL. Every scorecard carries a team invite link; whoever completes the quiz through that
link is attributed back to the sharer. Traffic is bursty and event-shaped: 100–1000 people
in a room over roughly twenty minutes, then near silence.

## What it needs from AWS

| Need | Minimum | Notes |
| --- | --- | --- |
| Compute | One container, 0.5 vCPU / 1 GB | It is a normal long-lived Node server. Scale to 2+ tasks for the event. |
| Database | Postgres 14+ | RDS `db.t4g.micro` is ample. The whole dataset is a few thousand rows. |
| TLS + domain | ACM cert + ALB (or CloudFront) | The public origin must be HTTPS. |
| Secrets | Secrets Manager or SSM Parameter Store | Four required variables; see below. **All are created by you** — nothing needs handing over from the current deployment. |
| Egress | Only if email is enabled | Outbound HTTPS to Resend. Nothing else calls out. |

There is **no** object storage, cache, queue, or background worker. Nothing is written to
local disk. Any container platform works — ECS Fargate, App Runner, EKS, or plain EC2.

## Recommended shape

```
Route 53 ─ ACM ─ ALB (:443) ─ ECS Fargate service (2 tasks, :3000)
                                      │
                                      └─ RDS Postgres (private subnet, SG allows 5432
                                                       from the task SG only)
```

App Runner is a smaller-footprint alternative that removes the ALB and the task
definition; it fits this workload and is the faster path if ECS is not already in use.

## Build and run

The repository ships a multi-stage `Dockerfile` producing a self-contained image.

```bash
docker build -t leader-archetype-quiz .
docker run -p 3000:3000 --env-file .env.production leader-archetype-quiz
```

Notes that matter:

- **The build needs no secrets and no database.** Every variable is read at runtime, so
  the image is safe to build in CI and promote unchanged between environments.
- The image runs as a non-root user and listens on `:3000` (`PORT` and `HOSTNAME` are
  overridable).
- `output: "standalone"` is switched on by `BUILD_STANDALONE=1`, which the Dockerfile sets.
- Migrations and the frozen scoring inputs are copied into the image, so the migrate task
  and the serving task can be the *same artefact*.

## Environment variables

Required:

| Variable | Example | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://quiz:…@db.…rds.amazonaws.com:5432/quiz?sslmode=require` | Secret. |
| `BASE_URL` | `https://archetype.example.com` | No trailing slash. See the warning below. |
| `ADMIN_USER` | `admin` | Basic Auth for `/admin`. |
| `ADMIN_PASS` | — | Secret. With either unset, `/admin` returns 503; it fails closed. |

Optional: `RESEND_API_KEY` and `EMAIL_FROM` (email is hidden entirely without the key),
`DATABASE_CA_CERT`, `DB_POOL_MAX`, `DB_POOL_IDLE_MS`, `DB_CONNECT_TIMEOUT_MS`.
`.env.example` documents all of them.

> ⚠️ **`BASE_URL` must be the final public origin before any QR code is printed.** Invite
> links and QR codes are generated from it at render time. Changing it later does not fix
> links already sitting in people's phones.

## Database setup

```bash
# 1. Create the database and a least-privilege application role.
CREATE DATABASE quiz;
CREATE ROLE quiz_app LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE quiz TO quiz_app;
GRANT USAGE, CREATE ON SCHEMA public TO quiz_app;

# 2. Apply migrations — a one-off task, from the same image, BEFORE the new version serves.
docker run --rm --env-file .env.production leader-archetype-quiz \
  node_modules/.bin/tsx scripts/migrate.ts
#   on ECS: aws ecs run-task … --overrides '{"containerOverrides":[{"name":"app",
#           "command":["node_modules/.bin/tsx","scripts/migrate.ts"]}]}'

# 3. Create the event row whose slug the QR code points at.
INSERT INTO events (slug, name) VALUES ('melbourne-aug', 'Melbourne — August');
```

Migrations are **not** applied automatically at boot, deliberately: several tasks starting
at once must not race each other. Run the task, wait for it, then roll the service.

`drizzle/*.sql` is plain Postgres DDL — readable and reviewable before you run it.

### TLS to RDS

Set `DATABASE_CA_CERT` to the contents of the regional bundle from
`https://truststore.pki.rds.amazonaws.com/` for full certificate verification. Without it,
a URL containing `sslmode=require` still encrypts but does not verify the server.

### Connection pooling

The app uses `node-postgres` with a small pool (`DB_POOL_MAX`, default 5) per process. On
long-lived containers that is all you need: two tasks × 5 connections is nothing against a
`t4g.micro`'s limit. **RDS Proxy is only necessary if you later move this to Lambda**,
where instance count is unbounded. Raise `DB_POOL_MAX` only alongside `max_connections`.

## The domain, and why its order matters

The app builds every invite link and QR code from `BASE_URL` **at the moment a page is
rendered**. There is no rewriting later. So the sequence is not negotiable:

1. Decide the subdomain (e.g. `archetype.example.com`).
2. Create the ACM certificate and the Route 53 record; point them at the ALB.
3. Set `BASE_URL` to `https://archetype.example.com` and **deploy**.
4. Confirm a scorecard renders an invite link on that exact origin.
5. *Only then* generate and print the QR code.

Do steps 3–4 before anyone takes the quiz for real. A scorecard rendered under the wrong
`BASE_URL` hands out invite links on the wrong host, and those links are already in
someone's phone by the time you notice.

The QR code should point at `https://<subdomain>/q/<event-slug>`.

## Cutover from the interim deployment

The app currently runs on a temporary host while AWS is built. Two things do **not** carry
across by themselves.

**Data.** The schema is three tables and the dataset is small, so a plain dump and restore
is the whole job:

```bash
pg_dump --no-owner --no-acl --data-only \
  -t events -t teams -t responses "$OLD_DATABASE_URL" > quiz-data.sql
psql "$NEW_DATABASE_URL" -f quiz-data.sql        # after migrations have been applied
psql "$NEW_DATABASE_URL" -c "SELECT setval(pg_get_serial_sequence('teams','id'),
                                           COALESCE((SELECT MAX(id) FROM teams), 1));"
psql "$NEW_DATABASE_URL" -c "SELECT setval(pg_get_serial_sequence('responses','seq'),
                                           COALESCE((SELECT MAX(seq) FROM responses), 1));"
```

Resetting those two sequences matters: `responses.seq` drives every "newest first" ordering
and `teams.id` is referenced by `responses.team_id`. Restore data without them and the next
insert collides on a primary key.

**Existing links.** Scorecard and invite URLs are permanent by promise, and they contain
the origin they were shared from. Anything handed out during testing on the old host will
**404 after cutover** unless you either keep the old deployment alive pointing at the same
database, or redirect the old host to the new one. If the testing links do not matter,
truncate and start clean instead — see below.

**Starting clean** (safe to run before a real event, and the safer default):

```sql
TRUNCATE TABLE responses, teams RESTART IDENTITY CASCADE;
```

⚠️ Do **not** include `events` in that statement. The event row is what makes
`/q/<slug>` attribute completions to the event; without it the quiz still works and every
response is silently stored with no event attached.

## Health checks

| Path | Use | Touches the database |
| --- | --- | --- |
| `GET /api/health` | ALB target group, container liveness | No |
| `GET /api/health?deep=1` | Monitoring, deploy readiness gate | Yes — 503 when unreachable |

Use the shallow one for the load balancer. If the ALB probes the deep one, a brief database
blip will cause it to kill and replace every healthy task at once.

## Scaling for an event

The heavy page is the QR landing page, and it is **statically rendered and never touches
the database** — a thousand simultaneous scans cost a cached HTML response each. The quiz
itself makes zero network calls between starting and submitting. The database is touched
exactly three times per person: one indexed lookup at submit, one transaction to write, and
two indexed reads when the scorecard renders.

Practically: two Fargate tasks handle a 1000-person room. Scale on CPU with a target of
60%, minimum 2 for redundancy. Warm the service before doors open — the first request after
a cold start pays the Node boot.

## Security posture as shipped

- `/admin` is HTTP Basic Auth (`proxy.ts`), and fails closed when unconfigured. **Basic
  Auth over HTTPS is the whole story** — if you want it behind SSO or IP-restricted to the
  office, do it at the ALB.
- Every response carries `X-Robots-Tag: noindex`, `Referrer-Policy`, `X-Content-Type-Options`.
- Scorecard and invite URLs are `nanoid(14)` — unguessable, but **anyone holding a URL can
  read that scorecard**. That is the intended design; it is why rosters show names and
  archetypes only, never contact details.
- All input is validated server-side with zod; all queries are parameterised via Drizzle.
- The `/api/submit` rate limit is **in-memory and per-instance**, sized to be generous
  because a whole venue shares one NAT address. It is abuse protection, not a gate. If you
  want a real limit across tasks, put it on the ALB or WAF.
- The database holds **personal data** — name, email, mobile, company. Encrypt the RDS
  volume, keep it in a private subnet, and set a retention policy for backups.

## What is host-specific and what is not

Nothing in `app/`, `components/` or `lib/` knows where it runs.

- `lib/db.ts` is the only file that knows how Postgres is reached. Plain `node-postgres`.
- `vercel.json` is inert outside Vercel; delete it once the migration is complete.
- `lib/env.ts` falls back to `VERCEL_URL` when `BASE_URL` is unset. On AWS `BASE_URL` is
  always set, so that branch never runs; it is safe to leave or remove.
- `proxy.ts` is Next's request-interception convention (formerly `middleware.ts`) and runs
  on the Node runtime under a normal server. It is not an edge function.

## Verifying a deployment

```bash
npm run verify          # typecheck, lint, 38 tests, production build
```

Then against the deployed origin:

1. `GET /api/health?deep=1` → `{"status":"ok","database":"ok"}`
2. `GET /q/<event-slug>` → 200, and the page's `/_next/static/*` chunks also 200. *If the
   HTML loads but the buttons do nothing, the static chunks are being blocked — check the
   CDN/ALB is not stripping or misrouting `/_next/`.*
3. `GET /admin` → 401; with the right credentials → 200.
4. Complete the quiz end to end on a phone, share the invite link to a second phone, and
   confirm the teammate appears on the first scorecard.

The full manual checklist is in the main `README.md`.
