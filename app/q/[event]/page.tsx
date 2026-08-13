import Quiz from "@/components/Quiz";
import { BrandFooter, BrandHeader } from "@/components/Brand";
import { EntryHero } from "@/components/EntryHero";
import { clientQuestions } from "@/lib/scoring";
import { eventSlugSchema } from "@/lib/validation";

/**
 * The QR target.
 *
 * Statically rendered and cached per slug — it makes no database call at all, so a
 * thousand simultaneous scans cost one cached HTML response each. Whether the slug is a
 * real event is decided later, on the server, at submit time: an unknown slug still
 * gives a working quiz, it is just stored as no event.
 */
export const dynamic = "force-static";
export const dynamicParams = true;

export function generateStaticParams() {
  return [];
}

export default async function EventEntryPage({ params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  const parsed = eventSlugSchema.safeParse(decodeURIComponent(event));
  const eventSlug = parsed.success ? parsed.data : null;

  return (
    <div className="page">
      <BrandHeader />
      <main className="container">
        <Quiz questions={clientQuestions} event={eventSlug} intro={<EntryHero />} />
      </main>
      <BrandFooter />
    </div>
  );
}
