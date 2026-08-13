# Theming

This app is built to be rebranded without touching a single component.

**Current theme: absolute monochrome.** Black, white and greys only — no accent hue
anywhere. Hierarchy comes from weight, scale, fill and contrast. A consequence worth
keeping when the brand palette lands: nothing in the interface depends on colour alone to
be understood, which is a WCAG requirement as well as an aesthetic choice.

## The whole job

1. Edit `app/theme.css` — every token is listed below.
2. Replace `public/logo.svg` with the brand mark (keep the filename; it renders 2rem tall).
3. Mirror any colour you changed into `lib/email-theme.ts` — see [The one duplicate](#the-one-duplicate).
4. Run `npm test`. The theme tests fail if the email palette drifts from `theme.css`, if a
   token is undocumented here, or if a raw colour has crept into `app/globals.css`.

That is the entire surface. No component file contains a colour, a font stack, a radius or
a spacing value; they all resolve through `var(--token)`.

## Rules for anyone adding UI

- **Never** write a raw colour, `px` radius, or ad-hoc spacing in a component or CSS module.
  Add a token here first, then use it.
- Component CSS modules own layout (flex, grid, sizes); `theme.css` owns appearance.
- Keep the placeholder theme at WCAG AA. Text on `--color-bg`, on `--color-accent`, and the
  strength/watch-out pairs are all checked against their backgrounds.

## Tokens

### Brand

| Token | Placeholder | Used for |
| --- | --- | --- |
| `--color-accent` | `#0a0a0a` | Primary buttons, links, progress bar, selected option, QR framing |
| `--color-accent-hover` | `#333333` | Primary button hover |
| `--color-accent-soft` | `#f1f1f1` | Selected option fill, "invited you" chip, closing CTA card |
| `--color-on-accent` | `#ffffff` | Text and icons sitting on `--color-accent` |

### Surfaces and text

| Token | Placeholder | Used for |
| --- | --- | --- |
| `--color-bg` | `#ffffff` | Page background |
| `--color-surface` | `#ffffff` | Cards, inputs, option tiles |
| `--color-surface-muted` | `#f6f6f6` | Table headers, progress track, email backdrop |
| `--color-text` | `#0a0a0a` | Body copy and headings |
| `--color-text-muted` | `#5c5c5c` | Secondary copy, labels, timestamps |
| `--color-border` | `#e2e2e2` | Card and table borders |
| `--color-border-strong` | `#b4b4b4` | Input borders, secondary button outline |

### Semantic

| Token | Placeholder | Used for |
| --- | --- | --- |
| `--color-strength` | `#0a0a0a` | Strengths column text |
| `--color-strength-bg` | `#f1f1f1` | Strengths column fill — the only thing separating the two sides of the coin |
| `--color-strength-border` | `#d4d4d4` | Strengths border (email) |
| `--color-watchout` | `#0a0a0a` | Watch-outs column text |
| `--color-watchout-bg` | `#ffffff` | Watch-outs column fill |
| `--color-watchout-border` | `#d4d4d4` | Watch-outs border (email) |
| `--color-danger` | `#0a0a0a` | Validation and error messages — meaning lives in the words, not the hue |
| `--color-danger-bg` | `#f1f1f1` | Error message fill |
| `--color-focus` | `#0a0a0a` | Keyboard focus ring |

### Typography

| Token | Placeholder | Used for |
| --- | --- | --- |
| `--font-sans` | system stack | Everything by default |
| `--font-display` | inherits `--font-sans` | Headings — point this at the brand display face |
| `--font-mono` | system mono | The invite URL readout |
| `--text-xs` | `0.8125rem` | Captions, table headers, footnotes |
| `--text-sm` | `0.9375rem` | Secondary copy, list items, form labels |
| `--text-base` | `1.0625rem` | Body |
| `--text-lg` | `1.1875rem` | Archetype essence line |
| `--text-xl` | `1.375rem` | Section headings (`h2`) |
| `--text-2xl` | `1.75rem` | Question text, admin stat values |
| `--text-3xl` | `2.25rem` | Page titles (`h1`) |
| `--weight-regular` | `400` | Body |
| `--weight-medium` | `550` | Buttons, labels, emphasis |
| `--weight-bold` | `700` | Headings |
| `--leading-tight` | `1.18` | Headings |
| `--leading-normal` | `1.55` | Body |
| `--tracking-wide` | `0.08em` | Uppercase section labels |

### Space

`--space-1` `0.25rem` · `--space-2` `0.5rem` · `--space-3` `0.75rem` · `--space-4` `1rem` ·
`--space-5` `1.5rem` · `--space-6` `2rem` · `--space-7` `3rem` · `--space-8` `4rem`

### Shape

| Token | Placeholder | Used for |
| --- | --- | --- |
| `--radius-sm` | `4px` | Selects, focus ring rounding |
| `--radius-md` | `8px` | Inputs, option tiles, list items |
| `--radius-lg` | `12px` | Cards |
| `--radius-pill` | `999px` | Buttons, chips, progress track |
| `--border-width` | `1px` | Default border weight |
| `--border-width-heavy` | `2px` | Column headings on the strengths/watch-outs coin |
| `--shadow-sm` | subtle | Cards |
| `--shadow-md` | soft | Reserved for raised surfaces |

### Signature block

The scorecard's emblem-plus-profile-shape element.

| Token | Placeholder | Used for |
| --- | --- | --- |
| `--emblem-size` | `8.5rem` | Width and height of the archetype emblem |
| `--emblem-stroke` | `2.25` | SVG stroke width of the emblem — a unitless number, in the emblem's 120×120 viewBox |
| `--chart-bar-height` | `0.5rem` | Height of each profile-shape bar |

The emblems in `components/ArchetypeEmblem.tsx` are drawn in `currentColor`, so they take
the surrounding text colour and need no change on rebrand.

### Layout and motion

| Token | Placeholder | Used for |
| --- | --- | --- |
| `--content-width` | `40rem` | Quiz and scorecard column |
| `--content-width-wide` | `76rem` | Admin tables |
| `--tap-target` | `3rem` | Minimum height for anything tappable |
| `--transition-fast` | `120ms ease` | Hover and selection |
| `--transition-base` | `200ms ease` | Progress bar |

Both transitions collapse to `0ms` under `prefers-reduced-motion: reduce`.

## The one duplicate

Email clients cannot resolve CSS custom properties, so the scorecard email carries literal
hex values. They live in `lib/email-theme.ts` and **must** match `app/theme.css`.
`tests/theme.test.ts` parses `theme.css` and asserts every mirrored token still matches, so
a rebrand that forgets the email fails the test suite rather than shipping a stale palette.

## What is deliberately not tokenised

The placeholder `public/logo.svg` has its ink baked in, because it is a placeholder. The
real logo replaces the file wholesale.
