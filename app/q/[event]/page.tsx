import InterviewChat from "@/components/InterviewChat";
import { BrandHeader } from "@/components/Brand";
import { EntryHero } from "@/components/EntryHero";
import { eventSlugSchema } from "@/lib/validation";

/**
 * The QR target.
 *
 * Statically rendered and cached per slug — it makes no database call at all, so a
 * thousand simultaneous scans cost one cached HTML response each. That holds under the
 * interview too: the first network call happens when the person starts, not when they
 * scan. Whether the slug is a real event is decided later, on the server, at submit
 * time: an unknown slug still gives a working quiz, it is just stored as no event.
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
      {/* container-fill, not plain container: the interview is a full-height app screen, and
          its composer must sit at the bottom of the viewport rather than under the thread. */}
      <main className="container container-fill">
        {/* The interview is the primary journey; the tap form survives inside it as the
            in-turn escape hatch and the turn-budget fallback. */}
        <InterviewChat event={eventSlug} intro={<EntryHero />} />
      </main>
      {/* No footer on the interview screen. This is the one page where vertical space is
          scarce — a 25-turn thread, a sticky composer and a soft keyboard — and the wordmark
          is already in the header. It stays on the scorecard and roster, which are the pages
          people actually share. */}
    </div>
  );
}
