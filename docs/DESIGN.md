# Design

## Idea
An *ostrakon* is a pottery shard. Athenians scratched a name on one to cast a vote.
- The palette is fired clay and ink on bone, like a shard and the hand that marks it.
- The phase glyph is a row of scratched notches, one per phase the election goes through (three for an open ballot, four for a secret ballot), filled up to the current phase.
- The logo is a shard with two cuts.

The product's job is to make a public record easy to check, so the visual language borrows from ledgers and registers. It uses hairline rules, numbered rows, monospace figures with tabular numerals, and strong horizontal structure. It avoids soft cards floating in space. The look should feel trustworthy and precise because it looks like a record, not like marketing.

**One light theme, done properly.** A dark theme would need a second contrast-verified palette and a second set of screenshots and checks. The brief allows doing one mode excellently, so I did. The network bar is the one ink-colored surface, which keeps "where am I, on what chain, as whom" visually separate from content.

## Tokens
Every color, type, space, and motion value lives in `web/src/styles/tokens.css`. `index.css` contains no hex values (checked with `grep -cE "#[0-9a-fA-F]{6}" web/src/styles/index.css` → `0`).

Contrast ratios are WCAG 2.x, computed with the relative-luminance formula by a script during development.

| Token | Hex | Role | On bone `#efe9dd` | On paper `#f8f4eb` |
|---|---|---|---|---|
| `--bone` | `#efe9dd` | page background | n/a | n/a |
| `--paper` | `#f8f4eb` | raised surfaces, panels, cards | n/a | n/a |
| `--sand` | `#e4dbcb` | sunken fills, disabled, fresh audit rows | n/a | n/a |
| `--ink` | `#1e1b16` | primary text, rules, network bar | **14.20** | **15.64** |
| `--ink-2` | `#4f483d` | secondary text | 7.47 | 8.22 |
| `--ink-3` | `#6b6253` | tertiary text (never on sand: 4.37) | 4.97 | 5.47 |
| `--rule` | `#b9ad97` | decorative hairlines only | 1.83 | 2.02 |
| `--rule-strong` | `#8f836c` | component borders (non-text, needs ≥ 3:1) | 3.08 | 3.40 |
| `--clay` | `#a3421b` | accent, primary action, leading candidate | 5.18 | 5.71 |
| `--clay-deep` | `#7c3112` | links, hover, pressed, **focus ring** | 7.54 | 8.30 |
| `--olive` | `#4a5f1e` | confirmed, voted, winner | 5.89 | 6.49 |
| `--ochre` | `#7d5a0c` | pending, Registration phase | 5.20 | 5.73 |
| `--oxblood` | `#8e2a22` | errors, failed transactions | 6.94 | 7.64 |
| `--on-solid` | `#f8f4eb` | text on clay (5.71) and ink (15.64) fills | n/a | n/a |

The network bar has `--ink` as its background:

| Token | Hex | Role | On ink |
|---|---|---|---|
| `--night-2` | `#b8ad99` | labels and secondary text | 7.74 |
| `--night-edge` | `#8d8371` | quiet button border | 4.59 |
| `--night-focus` | `#e9a07c` | focus ring | 8.00 |
| `--live` / `--down` | `#9cb86a` / `#e07a68` | chain status dot. The word beside it carries the meaning; color is never the only signal. | 7.75 / 5.85 |

**Hue check.** Every token's hue (HSL) falls between **4° and 82°**: red, clay, ochre, and olive. Nothing is in the 180–300° band where blue, indigo, cyan, teal, purple, and violet live. The hues come from a script over `tokens.css`, run during development.

**Hard bans, checked:**
- There is no blue, indigo, cyan, teal, purple, or violet anywhere.
- There are no gradients. A dashed rail I first drew with `repeating-linear-gradient` is now a `border-left: dashed`. `grep -rci gradient web/src` finds 0 files.
- There is no neon, glow, blur, glassmorphism, or `backdrop-filter`. `grep -rciE 'blur|backdrop|glow|text-shadow' web/src/styles` finds 0 files.
- The only "lift" is one hard `3px 3px 0` offset in ink on a hovered or open card: no blur, no stack.

## Type
All faces are self-hosted through `@fontsource` and bundled by Vite, so the app makes no third-party font requests. Public Sans and Plex Mono import only their Latin files. Fraunces' variable CSS also declares Latin-ext and Vietnamese subsets by `unicode-range`. They ship in `dist/`, but the browser only downloads the Latin file for this UI's text.

- **Fraunces** (variable, optical size axis) for display and headings.
  - It's a soft, slightly wonky old-style serif with real character at large sizes.
  - `opsz` is pushed to 144 for `h1` and 72 for `h2`/`h3`.
  - It gives the "public register" voice without looking antique.
- **Public Sans** for body and UI.
  - It's a neutral grotesque designed for the US Web Design System, made for civic, trust-sensitive interfaces.
  - It isn't one of the defaults (Inter, Roboto, system UI), and it stays very legible at small sizes in tables.
- **IBM Plex Mono** for addresses, hashes, block numbers, tallies, and figures.
  - `font-variant-numeric: tabular-nums slashed-zero` keeps columns aligned and stops 0/O confusion in hex.
  - Plex Mono lacks the `№` glyph, so the UI writes "No." instead.

The scale runs from `--step--1` (13px) to `--step-4` (a fluid `clamp(2.25rem … 3.5rem)`). Body line-height is 1.55, and the measure is limited to 68ch.

## Layout and components
- **The network bar is persistent and sticky.** It shows chain, live block, account, role, contract, and connect. At 720px and below, the contract item hides, but the contract address stays in the How-it-works text and the audit trail.
- **The ledger is a numbered register,** not a card grid.
  - Rows get a clay left border plus a paper fill on hover or focus-within.
  - Each row expands in place to show its on-chain record: creation tx, block, admin, and window, each with a copy button.
  - At 720px and below, rows re-flow into a stacked grid.
- **Candidate cards are real buttons** (`aria-expanded`), with:
  - a subtle pointer tilt (≤ 3°, mouse only)
  - a pressed scale
  - an inline expand showing votes, share, and index
  - a two-step vote: "Vote for X", then "Confirm vote", with a note that the choice is final and public
- **The on-chain record** is a vertical chain of real events grouped into phase bands, beside a pinned phase rail.
- **Tables collapse to labeled stacked rows** below 720px (`td::before { content: attr(data-label) }`).
- **No pill buttons.** Buttons are 2px-radius rectangles. Status tags are small uppercase outlined labels.

**Banned patterns I avoided:**
- no centered hero with two CTA cards (the home page *is* the ledger)
- no three-feature-card grid
- no emoji or icons in tinted circles (the only pictures are the shard logo and the notch glyph)
- no stock illustrations

## Motion
Everything animates **only `transform` and `opacity`**. The final value is always in the DOM.

| Effect | Purpose | Mechanism |
|---|---|---|
| **Scroll-linked phase rail** (Election page) | The rail fills as you scroll through the record, but **can't run past the election's real phase**: Registration-phase elections barely start it, each later phase fills one more segment (halves for open ballots, thirds for secret ballots), and Ended goes to the end. The scroll position shows where you are in the record; the filled part shows how far the election has actually got. | Passive scroll listener; one `getBoundingClientRect` per frame (rAF-throttled); writes `scaleY` |
| **Chain line drawn while scrolling** | The connecting line between real `#block` events grows with your reading position. | Same hook, `scaleY` |
| **Count-ups** (figures, tallies) | Numbers count up once when they enter the viewport. Screen readers always get the real value through an `sr-only` twin; the animated digits are `aria-hidden`. | IntersectionObserver + rAF |
| **Bars fill** | Vote share bars fill when seen. | `scaleX` with a CSS transition |
| **Staggered ledger rows** | Rows fade and lift in, 45ms apart. | `opacity` + `translateY` |
| **Card tilt** | Signals that the card is interactive. Mouse only; touch and pen get none. | Pointer → rAF → `rotateX/Y` |

**Guardrails:**
- There is no scroll-jacking and no smooth-scroll library. Native and keyboard scrolling are untouched.
- `prefers-reduced-motion: reduce` sets every duration token to 0ms and disables the scroll, tilt, count, and reveal effects. Values render final immediately. An E2E test checks this.
- Background tabs pause `requestAnimationFrame`, so count-ups show the final value when the document isn't visible, never a stalled 0.
- Measured: scrolling the whole election page at 4× CPU throttle, the longest frame was 4.3ms and none exceeded 16.7ms. See VERIFICATION.md.

## Accessibility
- A skip link and landmarks (`header`, `nav`, `main`, `footer`, labeled regions). Every field has a `<label>`.
- A visible 2px `--clay-deep` focus outline with 2px offset everywhere, and a light variant on the dark bar.
- Transaction progress and wallet notices are `aria-live="polite"`.
- Every interaction works by keyboard. The vote flow is tested with Tab, Enter, and Space only. No information is hover-only: the full hash is in `title` *and* behind a copy button.
- Usable at 360px with no horizontal scroll, checked on five routes by E2E.
- Lighthouse accessibility score: **100**.
