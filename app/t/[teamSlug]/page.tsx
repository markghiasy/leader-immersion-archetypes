import InterviewChat from "@/components/InterviewChat";
import { BrandHeader } from "@/components/Brand";
import { EntryHero } from "@/components/EntryHero";
import { teamOwnerBySlug } from "@/lib/queries";
import { publicIdSchema } from "@/lib/validation";
import { IntakeClosed } from "@/components/IntakeClosed";
import { intakeClosed } from "@/lib/env";

/**
 * Team invite landing — the second half of the growth loop.
 *
 * Evergreen and unlimited-use. One indexed lookup to personalise the headline; an
 * unrecognised link still gives a working quiz, just without attribution.
 */
export const dynamic = "force-dynamic";

export default async function TeamInvitePage({ params }: { params: Promise<{ teamSlug: string }> }) {
  const { teamSlug } = await params;
  const parsed = publicIdSchema.safeParse(teamSlug);

  const team = parsed.success ? await teamOwnerBySlug(parsed.data).catch(() => null) : null;

  return (
    <div className="page">
      <BrandHeader />
      {/* container-fill and no footer: the invite link renders the interview, not a roster,
          so it is the same full-height app screen as /q/[event]. */}
      <main className="container container-fill">
        {/* The unrecognised-link notice is suppressed once intake is closed: telling someone
            their invite link was not recognised, and then that they cannot take the quiz
            anyway, is two pieces of bad news where one will do. */}
        {!team && !intakeClosed() && (
          <p className="notice" style={{ marginBottom: "var(--space-4)" }}>
            We did not recognise that invite link, so we could not connect you to a team. You can still take the quiz
            and get your own scorecard.
          </p>
        )}
        {/* The interview is the primary journey; the tap form survives inside it as the
            in-turn escape hatch and the turn-budget fallback. */}
        {intakeClosed() ? (
          <IntakeClosed />
        ) : (
          <InterviewChat
            teamSlug={team ? team.teamSlug : null}
            intro={<EntryHero invitedBy={team?.ownerFirstName} />}
          />
        )}
      </main>
    </div>
  );
}
