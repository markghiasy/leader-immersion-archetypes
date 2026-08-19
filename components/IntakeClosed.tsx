import Link from "next/link";

/**
 * Shown in place of the interview once `INTAKE_CLOSED` is set.
 *
 * The tone matters more than it looks like it should: most people who land here will be
 * arriving from a colleague's invite link, days after the event, with no idea it has ended.
 * So this says what happened, confirms their scorecard still works if they already have one,
 * and does not apologise or offer a mailing list.
 */
export function IntakeClosed() {
  return (
    <section className="intake-closed">
      <h1>This exercise has closed</h1>
      <p>
        The Leader Archetype interview ran as part of the Leader Immersion in Melbourne and is no
        longer accepting new entries.
      </p>
      <p>
        <strong>If you already completed it, nothing has changed.</strong> Your scorecard link
        still works and will keep working — it is in the email we sent you, along with any
        guidance about the colleagues who joined through your invite.
      </p>
      <p className="intake-closed-quiet">
        Can&rsquo;t find the email? Search your inbox for &ldquo;Leader Archetype&rdquo;.
      </p>
      <p className="intake-closed-quiet">
        <Link href="https://aaronsansoni.com">aaronsansoni.com</Link>
      </p>
    </section>
  );
}
