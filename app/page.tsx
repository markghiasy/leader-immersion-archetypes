import Quiz from "@/components/Quiz";
import { BrandFooter, BrandHeader } from "@/components/Brand";
import { EntryHero } from "@/components/EntryHero";
import { clientQuestions } from "@/lib/scoring";

/** Generic entry point. No event, no team — direct entrants. Fully static. */
export const dynamic = "force-static";

export default function HomePage() {
  return (
    <div className="page">
      <BrandHeader />
      <main className="container">
        <Quiz questions={clientQuestions} intro={<EntryHero />} />
      </main>
      <BrandFooter />
    </div>
  );
}
