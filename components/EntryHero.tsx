import styles from "./quiz.module.css";

/**
 * The hero shown before the quiz starts. Rendered on the server so entry pages are
 * static HTML and cost nothing to serve during a QR-code rush.
 */
export function EntryHero({ invitedBy }: { invitedBy?: string | null }) {
  return (
    <>
      {invitedBy && (
        <span className={styles.invitedBy}>
          <strong>{invitedBy} invited you</strong> to discover your Leader Archetype
        </span>
      )}
      <h1 className={styles.heroTitle}>Discover your Leader Archetype</h1>
      <p className="muted">
        A short conversation reveals which of the eight leader archetypes you lead from — your natural strengths, and
        the habits worth watching. Answer in your own words, or tap an option any time you would rather. Then share it
        with your team and see how you fit together.
      </p>
      <div className={styles.meta}>
        <span>About 15 minutes</span>
        <span>25 questions</span>
        <span>Your scorecard is instant</span>
      </div>
    </>
  );
}
