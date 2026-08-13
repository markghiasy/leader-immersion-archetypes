import { ArchetypeEmblem } from "./ArchetypeEmblem";
import { allArchetypes, archetypeName } from "@/lib/content";
import styles from "./signature.module.css";

/**
 * The scorecard's signature block: the archetype's emblem alongside the shape of the
 * answers that produced it.
 *
 * The eight totals are already stored on every response and were previously invisible.
 * Bars are scaled against this person's own highest total, not a theoretical maximum,
 * because the profiles are not equally reachable — scaling to 25 would render every
 * chart as a row of stubs and say nothing.
 */
export function Signature({ profile, totals }: { profile: number; totals: number[] }) {
  const max = Math.max(...totals, 1);

  return (
    <section className={styles.signature} aria-label="Your archetype and profile shape">
      <div className={styles.emblem}>
        <ArchetypeEmblem profile={profile} title={archetypeName(profile)} />
      </div>

      <div className={styles.chart}>
        <h2 className={styles.chartHeading}>Your profile shape</h2>
        <dl className={styles.rows}>
          {allArchetypes.map((archetype) => {
            const total = totals[archetype.profile - 1] ?? 0;
            const isWinner = archetype.profile === profile;
            return (
              <div key={archetype.profile} style={{ display: "contents" }}>
                <dt className={`${styles.name} ${isWinner ? styles.nameWinner : ""}`}>
                  {archetype.name.replace(/^The /, "")}
                </dt>
                <dd className={styles.track} style={{ margin: 0 }}>
                  <div
                    className={`${styles.bar} ${isWinner ? styles.barWinner : ""}`}
                    style={{ width: `${(total / max) * 100}%` }}
                  />
                </dd>
                <dd className={`${styles.value} ${isWinner ? styles.valueWinner : ""}`} style={{ margin: 0 }}>
                  {total}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </section>
  );
}
