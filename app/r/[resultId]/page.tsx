import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BrandFooter, BrandHeader } from "@/components/Brand";
import EmailScorecard from "@/components/EmailScorecard";
import ShareBlock from "@/components/ShareBlock";
import { Signature } from "@/components/Signature";
import styles from "@/components/scorecard.module.css";
import { archetypeFor, archetypeName, archetypeTitle, mixSummary } from "@/lib/content";
import { emailEnabled, teamInviteUrl } from "@/lib/env";
import { getRoster, getScorecard } from "@/lib/queries";
import { publicIdSchema } from "@/lib/validation";

/**
 * The permanent scorecard.
 *
 * Public to anyone holding the URL — the unguessable id is the access control, which is
 * why the page is never indexed and why the roster shows names and archetypes only.
 * Two indexed reads, then plain HTML.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ScorecardPage({ params }: { params: Promise<{ resultId: string }> }) {
  const { resultId } = await params;
  const parsed = publicIdSchema.safeParse(resultId);
  if (!parsed.success) notFound();

  const card = await getScorecard(parsed.data);
  if (!card) notFound();

  const roster = await getRoster(card.ownTeamId);

  const { response } = card;
  const archetype = archetypeFor(response.profile);
  const inviteUrl = teamInviteUrl(card.ownTeamSlug);

  return (
    <div className="page">
      <BrandHeader />
      <main className="container">
        {/* 1 — the reveal */}
        <section className={styles.reveal}>
          <p className={styles.eyebrow}>{response.firstName}, you lead as</p>
          <h1 className={styles.title}>{archetypeTitle(response.profile)}</h1>
          <p className={styles.essence}>{archetype.essence}</p>
          <p className={styles.description}>{archetype.description}</p>
        </section>

        <div className={styles.sections}>
          {/* 2 — the signature block: emblem plus the shape of their answers */}
          <Signature profile={response.profile} totals={response.totals} />

          {/* 3 — strengths and watch-outs, two sides of one coin */}
          <div className={styles.coin}>
            <div className={styles.coinCol}>
              <h2 className={styles.coinHead}>Your strengths</h2>
              <ul className={styles.coinList}>
                {archetype.strengths.map((item) => (
                  <li key={item} className={styles.coinItem}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className={styles.coinCol}>
              <h2 className={styles.coinHead}>Watch-outs</h2>
              <ul className={styles.coinList}>
                {archetype.watchouts.map((item) => (
                  <li key={item} className={styles.coinItem}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* 4 — invite your team */}
          <section className="card">
            <h2>Invite your team</h2>
            <p className="muted small" style={{ margin: "var(--space-2) 0 var(--space-4)" }}>
              Share this link with your team. Everyone who completes the quiz through it gets their own scorecard, and
              appears below on yours.
            </p>
            <ShareBlock inviteUrl={inviteUrl} ownerFirstName={response.firstName} />
          </section>

          {/* 5 — team roster */}
          <section className="card">
            <h2>Your team</h2>
            {roster.length === 0 ? (
              <p className="muted small" style={{ marginTop: "var(--space-3)" }}>
                No teammates yet; share your link above.
              </p>
            ) : (
              <>
                <ul className={styles.roster} style={{ marginTop: "var(--space-3)" }}>
                  {roster.map((member, index) => (
                    <li key={`${member.firstName}-${index}`} className={styles.rosterItem}>
                      <span className={styles.rosterName}>
                        {member.firstName} {member.lastName}
                      </span>
                      <span className={styles.rosterArchetype}>{archetypeName(member.profile)}</span>
                    </li>
                  ))}
                </ul>
                <p className={styles.mix}>{mixSummary(roster.map((m) => m.profile))}</p>
              </>
            )}
          </section>

          {/* 6 — joined someone else's team */}
          {card.joinedOwnerFirstName && (
            <p className="muted small center">You joined {card.joinedOwnerFirstName}&rsquo;s team.</p>
          )}

          {/* 7 — email me my scorecard */}
          {emailEnabled() && (
            <section className="card">
              <h2>Email me my scorecard</h2>
              <p className="muted small" style={{ margin: "var(--space-2) 0 var(--space-4)" }}>
                We will send this scorecard and a link back to this page.
              </p>
              <EmailScorecard resultId={response.id} defaultEmail={response.email} />
            </section>
          )}

          {/* 8 — loop back for whoever this URL was shared with */}
          <section className={`card ${styles.ctaCard}`}>
            <h2>Was this shared with you?</h2>
            <p className="muted small" style={{ margin: "var(--space-2) 0 var(--space-4)" }}>
              Take the quiz and find out how you lead.
            </p>
            <a className="button" href={inviteUrl}>
              Discover your own archetype
            </a>
          </section>
        </div>
      </main>
      <BrandFooter />
    </div>
  );
}
