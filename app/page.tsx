import InterviewChat from "@/components/InterviewChat";
import { IntakeClosed } from "@/components/IntakeClosed";
import { BrandHeader } from "@/components/Brand";
import { EntryHero } from "@/components/EntryHero";
import { intakeClosed } from "@/lib/env";

/** Generic entry point. No event, no team — direct entrants. Fully static. */
export const dynamic = "force-static";

export default function HomePage() {
  return (
    <div className="page">
      <BrandHeader />
      {/* container-fill and no footer: this renders the interview, and every page that does
          is a full-height app screen whose composer belongs at the bottom of the viewport. */}
      <main className="container container-fill">
        {/* The interview is the primary journey; the tap form survives inside it as the
            in-turn escape hatch and the turn-budget fallback. */}
        {intakeClosed() ? <IntakeClosed /> : <InterviewChat intro={<EntryHero />} />}
      </main>
    </div>
  );
}
