# Leader Archetype Quiz

A typeform-style quiz for live events. An attendee scans a QR code, answers 25 questions one
at a time, and lands on a permanent scorecard showing one of eight leader archetypes. Every
scorecard carries a team invite link: anyone who completes the quiz through it is attributed
back to the sharer, appears on the sharer's roster, and gets a scorecard and invite link of
their own. That loop is the point of the product, not a feature bolted on the side.

Built for 100–1000 people finishing the quiz at once, on phones.

> **Testing or auditing this?** Read **[docs/PRODUCTION.md](docs/PRODUCTION.md)** first. It
> records what production actually is, and which findings from a laptop do not transfer to
> it — rate limiting, pooling, latency and 429s all behave differently there.

## Contents

- [Quick start](#quick-start)
- [Environment](#environment)
- [Deploying](#deploying)
- [Custom domain](#custom-domain)
- [How it works](#how-it-works)
- [Scoring is frozen](#scoring-is-frozen)
- [Tests](#tests)
- [Manual smoke test](#manual-smoke-test)
- [Hosting](#hosting)
- [Project layout](#project-layout)

## Quick start

```bash
npm install
cp .env.example .env.local        # fill in DATABASE_URL at minimum
npm run db:migrate                # apply drizzle/*.sql
npm run seed                      # one demo event + a team with two members
npm run dev
```

Then open the URLs the seed prints: an event entry page, a populated scorecard, its invite
link, and `/admin`.

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Local dev server |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Full test suite (scoring replay, API, seed, theming) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run verify` | typecheck + lint + test + build, in that order |
| `npm run db:generate` | Generate a migration from `lib/schema.ts` after a schema change |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:studio` | Drizzle Studio against `DATABASE_URL` |
| `npm run seed` | Demo event, team and responses |
| `docker compose up -d` | Local Postgres on port 5433 for development |

## Environment

Copy `.env.example` to `.env.local`. Every variable:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Any standard Postgres URL — RDS, Aurora, a container, or a managed provider. Use the **pooled** endpoint if your provider offers one. |
| `BASE_URL` | yes in production | Absolute origin, no trailing slash. Builds invite links, QR codes and email buttons. Falls back to `VERCEL_URL`, then `http://localhost:3000`. |
| `ADMIN_USER` | yes | HTTP Basic Auth for `/admin`. |
| `ADMIN_PASS` | yes | With either unset, `/admin` returns 503 — it fails closed. |
| `RESEND_API_KEY` | no | Without it the "email me my scorecard" section is hidden and a startup warning is logged. Everything else works. |
| `EMAIL_FROM` | no | e.g. `Leader Archetype <noreply@yourdomain.com>`. Must be a domain verified in Resend. |

## Deploying

For AWS, follow **[docs/AWS-DEPLOYMENT.md](docs/AWS-DEPLOYMENT.md)** instead — it covers the
container build, RDS, health checks and scaling. The steps below are the Vercel path.

1. **Create the database.** Any Postgres. If your provider offers a pooled endpoint, use
   it — serverless functions open many short connections.

2. **Create the Vercel project.** Import the repo. Framework preset: Next.js. No build
   command overrides are needed.

3. **Set environment variables** in Vercel → Settings → Environment Variables, for Production
   and Preview: `DATABASE_URL`, `BASE_URL`, `ADMIN_USER`, `ADMIN_PASS`, and optionally
   `RESEND_API_KEY` and `EMAIL_FROM`. Set `BASE_URL` to the final public origin
   (e.g. `https://archetype.yourdomain.com`) — invite links and QR codes are built from it,
   and a wrong value ships wrong links into people's phones.

4. **Run migrations.** These are not run automatically, deliberately — several instances
   starting at once must not race each other. From your machine, with the production
   `DATABASE_URL` in your environment:

   ```bash
   DATABASE_URL="postgresql://…" npm run db:migrate
   ```

   To create a new migration after changing `lib/schema.ts`:

   ```bash
   npm run db:generate     # writes drizzle/NNNN_name.sql — commit it
   npm run db:migrate      # applies it
   ```

   `npm run db:push` exists for throwaway databases; use `generate` + `migrate` for anything
   real, so the change is reviewable and repeatable.

5. **Seed if you want demo data.** `DATABASE_URL="…" npm run seed`. Skip this for a real
   event; instead insert the event row you need:

   ```sql
   insert into events (slug, name) values ('melbourne-aug', 'Melbourne — August');
   ```

   The event slug is what makes `/q/melbourne-aug` attribute responses to that event. An
   unknown slug still gives a working quiz; the response is just stored with no event.

6. **Point the QR code** at `https://your-domain/q/<event-slug>`.

### Custom domain

Vercel → Settings → Domains → add the domain, then create the DNS record Vercel shows you
(`CNAME` to `cname.vercel-dns.com` for a subdomain, or the apex `A` record). Once it
resolves, update `BASE_URL` to the new origin and redeploy — links already printed on
existing scorecards use whatever `BASE_URL` was at render time, so change it before the
event, not during.

## How it works

| Route | Rendering | Database |
| --- | --- | --- |
| `/q/[event]` | static, cached | none — a thousand scans cost nothing |
| `/` | static | none |
| `/t/[teamSlug]` | dynamic | one indexed lookup for the inviter's name |
| `/r/[resultId]` | dynamic | two indexed reads |
| `/admin` | dynamic, Basic Auth | filtered reads |
| `/api/interview/start` | dynamic, rate-limited | one draft insert |
| `/api/interview/turn` | dynamic, rate-limited | one draft update per turn; the response row on the last |
| `/api/submit` | dynamic, rate-limited | the single write — tap form and turn-budget fallback |
| `/api/health` | dynamic | none — add `?deep=1` to check Postgres too |

**The interview is the primary journey.** Instead of tapping through 25 questions, the person
is asked them one at a time in conversation and answers in their own words. The agent asks
question N and only ever reads question N out of the reply — mining several answers out of one
narrative was measured at 60.6% accuracy and is not built. The question text itself is
verbatim from the frozen schema; the model writes the sentence before it, never the question.
An answer the extractor is not confident about is never kept — the controller asks a narrowing
question instead, because one wrong answer in 25 changes the archetype 15.4% of the time.

**The tap form is the floor, not a legacy path.** The four options sit one tap away on every
turn, so anyone who would rather not type simply taps and moves on, and if the turn budget runs
out the remaining questions are handed to the form to finish. In a room, that floor is the
difference between a slow completion and a lost one. Every response records which instrument
produced it — `tap`, `interview` or `interview_fallback` — because otherwise there is no way to
tell a shifted archetype distribution caused by the new instrument from one caused by the
cohort.

Budget the time honestly: the tap form takes about 3 minutes, a typed interview 16–20.

The entry pages still make no database call, so a QR rush is as cheap as it ever was — the
first request happens when someone starts, not when they scan. From there the interview does
call the server each turn, and persists a draft as it goes: a 16–20 minute conversation cannot
live in React state the way a 3-minute form can, and losing it to a locked phone would be
losing the whole session. Drafts are a separate, disposable tier and are swept after 48 hours.
The tap form is unchanged and still holds everything in React until submit.

The canonical write happens **once**, at the end, whichever instrument got there: validate →
score server-side → insert the response and create its team inside a single transaction. Either
both rows land or neither does, so there is no state in which a scorecard exists without its
invite link. An abandoned quiz still produces no response row.

Attribution is one hop only. A teammate joining via your link appears on your roster and
gets their own fresh invite link; their invitees form a new tree, not a downline.

## Scoring is frozen

`inputs/archetype-schema.json` is the source of truth: 25 questions, 4 options each, each
option incrementing zero, one or two of eight profile counters. It was reverse-engineered
from 499 real responses and validated 499/499. Some options legitimately increment nothing —
that is not a bug to fix.

- Highest total wins; **ties break to the lowest profile number**.
- Scoring runs server-side only, in the pure `score()` in `lib/scoring.ts`. The browser is
  sent question and option *text* only, never the mappings.
- The schema's 8 replay vectors (2 of which exercise the tie-break) run in the test suite and
  assert exact totals and winner. **If one fails, the implementation is wrong — never the
  schema, never the test.**
- `inputs/archetype-content.json` is presentation copy only. It cannot affect scoring, and a
  test asserts the client payload contains no profile data.

## Tests

```bash
npm test
```

38 tests across four files:

- `tests/scoring.test.ts` — all 8 replay vectors; every one of the 100 option mappings
  applied in isolation; tie-break direction; purity; the client payload leaking nothing.
- `tests/api.test.ts` — the submit route end to end against **real Postgres running in
  process** (PGlite): happy path, event resolution, team attribution, unrecognised invite
  links, roster dedupe-by-email on retake, roster carrying no contact details, and validation
  rejections writing nothing at all.
- `tests/seed.test.ts` — the seed leaves `/admin` and a roster with something to render, and
  the admin filters behave.
- `tests/theme.test.ts` — the email's mirrored palette matches `theme.css`, every token is
  documented in `THEMING.md`, no raw colours outside `theme.css`, and the email escapes names.

The API tests run the same Drizzle queries as production against a different driver, which is
also the standing proof that the app is not coupled to any one Postgres host.

## Manual smoke test

Run through this before an event, on a phone, against the deployed URL.

Allow more time than you used to: typing your way through is a 16–20 minute exercise. Tap
your way through instead (step 6) when you only want to re-check the end of the journey.

**Event journey — the interview**

1. Scan the QR / open `/q/<event-slug>` → hero and Start button, and it renders instantly with
   the network throttled: the entry page still makes no request of its own.
2. Start → contact form. Submit it empty → inline errors on first name, last name, email,
   mobile. Company is optional.
3. Fill it in → the agent's opening turn, ending in question 1 **word for word** as it appears
   in `inputs/archetype-schema.json`. The four options are visible under it, and the progress
   bar carries no "N of 25" label.
4. Answer in your own words, in a full sentence → the reply acknowledges what you said and asks
   question 2 verbatim. Nothing you did not say is attributed to you.
5. Answer the next one vaguely, or with something that could be two of the options → the agent
   asks a narrowing question rather than guessing. Answer it clearly → it moves on.
6. Tap one of the four options instead of typing → it is taken as your answer immediately, and
   the agent moves to the next question. This is the escape hatch; it must work on every turn.
7. Send an empty reply, and something off-topic → neither is accepted as an answer and neither
   loses your place.
8. Lock the phone mid-interview, or reload the tab → the conversation is still there, with
   every answer so far.
9. Keep going to the end → "Calculating your archetype…" → lands on `/r/{id}`.
10. Scorecard shows: number + name, essence, description, 4 strengths (green), 4 watch-outs
    (amber), invite link, QR, empty roster, email section, closing CTA.
11. Copy the scorecard URL, open it in a private window → identical page. Reload → still there.
12. In `/admin`, that response's source records it as an interview, not a tap.

**The tap form — escape hatch and floor**

13. Start a fresh interview and answer every turn with something unusable ("dunno") until the
    turn budget runs out → it does **not** dead-end. The remaining questions appear as the tap
    form, and finishing them lands on a normal scorecard, recorded as the fallback source.
14. On the tap form: tap an option → it highlights and auto-advances. Tap **Back** → the
    previous question is still selected and editable.
15. Tab to the options and use arrow keys → selection moves without skipping ahead; **Next**
    advances. Focus ring is visible throughout, in the chat and on the form.
16. Turn the network off mid-interview and send a reply → a plain "we could not save that"
    message and a retry that works, not a lost conversation.

**Team journey (the loop)**

17. On the scorecard, tap **Copy link** → "Link copied." On iOS/Android, **Share** opens the
    native sheet.
18. Open the invite link on a second phone → "**{first name} invited you**" above the hero.
19. Complete the quiz there → that person gets their own scorecard, with the quiet line
    "You joined {first name}'s team." and their **own** invite link (different from the first).
20. Reload the first person's scorecard → the teammate appears by name and archetype, with
    the mix summary line. No email or phone number anywhere on the roster.
21. Scan the QR on the scorecard with a third phone → same invite landing page.
22. Open `/t/aaaaaaaaaaaaaa` (a bogus slug) → friendly note, the interview still starts, no
    attribution.
23. Open `/r/nonsense` → the "could not find that scorecard" page, not an error.

**Email** (only if `RESEND_API_KEY` is set)

24. On a scorecard, the email field is pre-filled with the address given at capture. Send →
    "Sent." The email reproduces archetype, description, strengths, watch-outs, and its button
    opens the same scorecard.
25. Send four times in an hour → the fourth is refused with a friendly message.

**Admin**

26. Open `/admin` → browser prompts for credentials. Wrong password → prompt again.
27. Correct credentials → responses table with name, email, mobile, company, archetype,
    source, invited-by, timestamp; archetype distribution above it; teams table below.
28. Filter by event, archetype and source → counts and rows both update.
29. **Export CSV** → downloads the current filter with all contact fields and attribution.
30. Open `/admin/export` in a private window → 401, not a CSV.

## Hosting

The app is **host-neutral**: a normal Node server plus standard Postgres via
`node-postgres`. No object storage, cache, queue, or worker; nothing is written to local
disk; no edge-only APIs. It runs unchanged on ECS Fargate, App Runner, EC2, or any other
platform that runs a container, and on Vercel.

- **AWS** — see **[docs/AWS-DEPLOYMENT.md](docs/AWS-DEPLOYMENT.md)**. A multi-stage
  `Dockerfile` ships in the repo; the build needs no secrets and no database.
- **Local Postgres** — `docker compose up -d` gives you one on port 5433, no cloud account
  needed.
- `vercel.json` is inert anywhere else and can be deleted once the migration is done.

`lib/db.ts` is the only file in the app that knows how the database is reached.

## Project layout

```
app/
  theme.css               all design tokens — the rebrand surface (see THEMING.md)
  globals.css             structural styles; no raw colours
  page.tsx                generic entry (static)
  q/[event]/              QR target (static, no DB)
  t/[teamSlug]/           invite landing
  r/[resultId]/           permanent scorecard
  admin/                  dashboard + CSV export
  api/submit/             the single write
  api/email-scorecard/    Resend send, rate-limited per scorecard
components/               Quiz, ShareBlock, EmailScorecard, chrome
lib/
  scoring.ts              the frozen pure score()
  schema.ts               Drizzle tables
  db.ts                   THE DRIVER SEAM — the only file that knows how Postgres is reached
  queries.ts              all data access
  validation.ts           zod schemas shared by client and server
  email.ts                branded scorecard email
inputs/                   archetype-schema.json (frozen) + archetype-content.json (copy)
drizzle/                  generated migrations
scripts/                  migrate.ts, seed.ts
tests/                    scoring replay, API, seed, theming
proxy.ts                  Basic Auth for /admin
```
