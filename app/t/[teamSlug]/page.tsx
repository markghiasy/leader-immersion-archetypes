import InterviewChat from "@/components/InterviewChat";
import { BrandFooter, BrandHeader } from "@/components/Brand";
import { EntryHero } from "@/components/EntryHero";
import { teamOwnerBySlug } from "@/lib/queries";
import { publicIdSchema } from "@/lib/validation";

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
      <main className="container">
        {!team && (
          <p className="notice" style={{ marginBottom: "var(--space-4)" }}>
            We did not recognise that invite link, so we could not connect you to a team. You can still take the quiz
            and get your own scorecard.
          </p>
        )}
        {/* The interview is the primary journey; the tap form survives inside it as the
            in-turn escape hatch and the turn-budget fallback. */}
        <InterviewChat
          teamSlug={team ? team.teamSlug : null}
          intro={<EntryHero invitedBy={team?.ownerFirstName} />}
        />
      </main>
      <BrandFooter />
    </div>
  );
}
