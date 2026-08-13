/**
 * One geometric emblem per archetype, drawn inline in `currentColor` so the whole set
 * inherits whatever the theme's ink is — no image assets, no licensing, no network.
 *
 * Each mark is a plain reading of its archetype rather than decoration:
 *   1 Innovator  — a burst radiating from a centre point
 *   2 Influencer — concentric ripples spreading outward
 *   3 Guide      — a path climbing through waypoints
 *   4 Negotiator — two arcs interlocking without merging
 *   5 Play Maker — a market line timed at its peak
 *   6 Architect  — courses stacked into a structure
 *   7 Guardian   — a shield enclosing what it protects
 *   8 Engineer   — a mechanism of meshed parts
 */

const VIEW = 120;

function paths(profile: number) {
  switch (profile) {
    case 1: // Innovator — burst
      return (
        <>
          <circle cx="60" cy="60" r="13" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
            const rad = (angle * Math.PI) / 180;
            const inner = 24;
            const outer = angle % 90 === 0 ? 50 : 40;
            return (
              <line
                key={angle}
                x1={60 + Math.cos(rad) * inner}
                y1={60 + Math.sin(rad) * inner}
                x2={60 + Math.cos(rad) * outer}
                y2={60 + Math.sin(rad) * outer}
              />
            );
          })}
        </>
      );
    case 2: // Influencer — ripples
      return (
        <>
          <circle cx="60" cy="60" r="9" />
          <circle cx="60" cy="60" r="22" />
          <circle cx="60" cy="60" r="35" />
          <circle cx="60" cy="60" r="48" strokeDasharray="6 9" />
        </>
      );
    case 3: // Guide — a path through waypoints
      return (
        <>
          <polyline points="22,88 46,64 74,74 98,32" />
          <circle cx="22" cy="88" r="6" />
          <circle cx="46" cy="64" r="6" />
          <circle cx="74" cy="74" r="6" />
          <circle cx="98" cy="32" r="8" />
        </>
      );
    case 4: // Negotiator — interlocking arcs
      return (
        <>
          <path d="M70 32a28 28 0 1 0 0 56" />
          <path d="M50 32a28 28 0 1 1 0 56" />
          <line x1="60" y1="46" x2="60" y2="74" />
        </>
      );
    case 5: // Play Maker — market line, timed
      return (
        <>
          <polyline points="18,84 38,68 54,76 72,40 88,54 102,26" />
          <circle cx="72" cy="40" r="7" />
          <line x1="18" y1="98" x2="102" y2="98" strokeDasharray="4 8" />
        </>
      );
    case 6: // Architect — stacked courses
      return (
        <>
          <rect x="30" y="76" width="60" height="20" />
          <rect x="38" y="52" width="44" height="20" />
          <rect x="46" y="28" width="28" height="20" />
        </>
      );
    case 7: // Guardian — shield
      return (
        <>
          <path d="M60 20 96 34v30c0 22-16 32-36 40-20-8-36-18-36-40V34z" />
          <path d="M60 44v34" />
          <path d="M44 58h32" />
        </>
      );
    case 8: // Engineer — meshed mechanism
      return (
        <>
          <circle cx="48" cy="48" r="20" />
          <circle cx="48" cy="48" r="7" />
          <circle cx="82" cy="80" r="13" />
          <circle cx="82" cy="80" r="4.5" />
          {[0, 60, 120, 180, 240, 300].map((angle) => {
            const rad = (angle * Math.PI) / 180;
            return (
              <line
                key={angle}
                x1={48 + Math.cos(rad) * 20}
                y1={48 + Math.sin(rad) * 20}
                x2={48 + Math.cos(rad) * 28}
                y2={48 + Math.sin(rad) * 28}
              />
            );
          })}
        </>
      );
    default:
      return <circle cx="60" cy="60" r="40" />;
  }
}

export function ArchetypeEmblem({ profile, title }: { profile: number; title: string }) {
  return (
    <svg
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      role="img"
      aria-label={`${title} emblem`}
      fill="none"
      stroke="currentColor"
      strokeWidth="var(--emblem-stroke)"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="100%"
      height="100%"
    >
      {paths(profile)}
    </svg>
  );
}
