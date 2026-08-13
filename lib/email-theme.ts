/**
 * Email clients cannot resolve CSS custom properties, so the handful of tokens the
 * scorecard email needs are mirrored here as literals.
 *
 * These values MUST match app/theme.css. `tests/theme.test.ts` parses theme.css and
 * fails the build if they drift, so a rebrand cannot silently leave the email behind.
 * See THEMING.md.
 */
export const emailTokens = {
  "--color-accent": "#0a0a0a",
  "--color-on-accent": "#ffffff",
  "--color-accent-soft": "#f1f1f1",
  "--color-bg": "#ffffff",
  "--color-surface-muted": "#f6f6f6",
  "--color-text": "#0a0a0a",
  "--color-text-muted": "#5c5c5c",
  "--color-border": "#e2e2e2",
  "--color-strength": "#0a0a0a",
  "--color-strength-bg": "#f1f1f1",
  "--color-watchout": "#0a0a0a",
  "--color-watchout-bg": "#ffffff",
  "--color-border-strong": "#b4b4b4",
  "--font-sans":
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
} as const;

export type EmailTokenName = keyof typeof emailTokens;
