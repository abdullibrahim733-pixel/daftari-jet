---
kind: frontend_style
name: Tailwind CSS v4 + Design Tokens (Apple-inspired Dark UI)
category: frontend_style
scope:
    - '**'
source_files:
    - src/styles/tokens.css
    - src/styles/globals.css
    - postcss.config.mjs
    - package.json
---

## System / Approach

The Daftari Dashboard is styled with **Tailwind CSS v4** (`tailwindcss@4.3.3`, `@tailwindcss/postcss@4.3.3`) configured via PostCSS (`postcss.config.mjs`). There is no `tailwind.config.*` file — Tailwind v4 uses a configuration-less approach, and theme tokens are declared directly in CSS using the `@theme` at-rule.

The visual identity follows an **Apple Design System** aesthetic described in the token header: pitch-black matte background (`#0B0B0F`), stark white text, and a single accent color — **Crimson Red (`#FF1133`)** — used under "absolute constraint" for high-priority interactive accents only. The design emphasizes clarity, deference, and depth, with bento-style cards, soft borders, backdrop-blur glass overlays, and spring-physics micro-interactions.

There is no component library (no shadcn/ui, Radix primitives, etc.). Components are built as plain React components styled with Tailwind utility classes plus a small set of hand-written CSS classes in `src/styles/globals.css`. No SCSS/Sass or CSS-in-JS is used.

## Key Files

- `src/styles/tokens.css` — Single source of truth for all design tokens (colors, radii, shadows, fonts, z-index scale, spacing base, motion variables) exposed via `@theme`.
- `src/styles/globals.css` — Imports Tailwind and tokens, defines `@layer base` resets (dark mode, focus-visible, typography), `@layer utilities` helpers (`.bento-card`, `.glass`, `.btn-crimson`, `.skip-link`), and page-level layout styles (sidebar, topbar, dashboard frame, stat cards, notices, empty states).
- `postcss.config.mjs` — Registers `@tailwindcss/postcss` plugin; no other plugins.
- `package.json` — Declares `next`, `react`, `tailwindcss`, `@tailwindcss/postcss`, `postcss`.

## Architecture and Conventions

### Token-first design
All colors, radii, shadows, fonts, z-index values, spacing, and motion parameters live in `tokens.css` under a single `@theme` block. Component CSS references them exclusively via CSS custom properties (e.g. `var(--color-crimson)`, `var(--radius-pill)`, `var(--spring-easing)`). Hardcoded color literals in component CSS are discouraged by the token system; where they appear (e.g. some legacy banner backgrounds like `#f0f6f1`, `#ffe2b6`), they are exceptions rather than the rule.

### Layered CSS organization
`globals.css` uses Tailwind's `@layer` directive:
- `@layer base` — global resets, dark-mode root, typography defaults, accessible focus ring.
- `@layer utilities` — reusable shared classes (`.bento-card`, `.glass`, `.btn-crimson`, `.text-muted`, `.border-border`, `.bg-surface`).
- Top-level selectors — page and layout styles (`.dashboard-frame`, `.sidebar`, `.topbar`, `.page-content`, `.stat-card`, `.notice`, `.empty-state`, etc.) that are scoped to specific views rather than reused as utilities.

### Accessibility baked into the base layer
- `color-scheme: dark` on `:root`.
- WCAG 2.2 AA-compliant visible focus ring via `:focus-visible` with crimson outline.
- Skip link (`.skip-link`) hidden off-screen until focused.
- Screen-reader-only helper (`.sr-only`).
- Comment: "Never rely on colour alone for meaning" accompanies table reset.

### Motion system
All transitions use the shared `--default-transition-duration` (300ms) and `--spring-easing` (`cubic-bezier(0.34, 1.56, 0.64, 1)`) tokens. Interactive elements apply a `--click-scale` (0.98) transform on `:active`. Glass panels use `backdrop-filter: blur(20px)` consistently.

### Layout model
A fixed left sidebar (256px, `position: fixed`, `z-index: var(--z-sticky)`) with a main content area offset by `margin-left: 256px`. A sticky topbar with glass effect sits above page content constrained to `min(100%, 1536px)` centered width.

### Responsive strategy
Responsive behavior is handled primarily through Tailwind utility classes applied inline in JSX components (not shown here but consistent with Tailwind usage). The CSS itself contains minimal media-query logic; breakpoints are expected to be expressed as Tailwind utilities.

## Conventions and Constraints

- **Token discipline**: Colors, radii, shadows, fonts, z-index, spacing, and motion must come from `tokens.css` `@theme` variables. This is enforced by the project's stated design-token architecture (the token file is the single source of truth).
- **Dark mode only**: `color-scheme: dark` is set globally; there is no light-mode toggle or alternate theme.
- **Crimson is the sole accent**: Per the token header comment, `#FF1133` is reserved for "high-priority interactive accents, single active tab markers, or terminal focal points" and should not flood the screen.
- **No config file**: Tailwind v4 is used without `tailwind.config.*`; all customization goes through CSS `@theme` and `@import 'tailwindcss'`.
- **Layered CSS**: New shared styles belong in `@layer base` or `@layer utilities` inside `globals.css`; view-specific layout styles go as top-level selectors in the same file.
- **Accessibility baseline**: All interactive elements must provide a visible focus ring matching the `:focus-visible` rule; skip links and `.sr-only` text are required for keyboard/screen-reader users.
- **Glass/depth pattern**: Overlays and floating surfaces consistently use `backdrop-filter: blur(20px)` plus `box-shadow` from the `--shadow-*` tokens.