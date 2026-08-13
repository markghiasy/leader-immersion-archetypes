import InterviewChat from "@/components/InterviewChat";
import { BrandFooter, BrandHeader } from "@/components/Brand";
import { EntryHero } from "@/components/EntryHero";

/** Generic entry point. No event, no team — direct entrants. Fully static. */
export const dynamic = "force-static";

export default function HomePage() {
  return (
    <div className="page">
      <BrandHeader />
      <main className="container">
        {/* The interview is the primary journey; the tap form survives inside it as the
            in-turn escape hatch and the turn-budget fallback. */}
        <InterviewChat intro={<EntryHero />} />
      </main>
      <BrandFooter />
    </div>
  );
}
