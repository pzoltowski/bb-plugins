# Turn Stats — design notes

Mocks (open the HTML in a browser for live hover states):

- `bb-turn-stats-mock.html` — all placement variants + panel prototypes
- `bb-turn-stats-mock.png` — rendered screenshot
- `bb-turn-stats-card-variants.html` — 8 hover-card header layouts
- `bb-turn-stats-card-variants.png` — rendered screenshot

## Chosen surfaces (v1)

**F — context-bar icon + hover card.** A small chart icon in the thread header
action row (nearest supported placement to the project/branch/Full-Access bar —
there is no dedicated slot *inside* that row). Hover opens a card with the
latest/active turn: stacked token bar, per-category counts, duration, model,
avg tok/s, estimated cost, session totals. Click pins nothing — it opens the
side panel.

**B — message hover action.** Adds "Turn stats" to the existing per-message
toolbar (next to Copy). Opens the panel deep-linked to that message's turn via
`message.sourceSeqEnd` → turn seq window. The slot has no role filter, so the
icon also shows on user prompts; for those it focuses the turn the prompt
started.

**E1 — side panel, compact list.** Legend (`input / cached / reasoning /
output`), per-turn rows with status dot, duration, mini stacked bar, token
counts, t/s, est. cost. Header shows session start, last activity, model;
footer shows cumulative totals and estimated session cost.

## Alternatives kept in the mock

- **A** header chip with always-visible numbers — more clutter; icon+card won.
- **C** inline line under "Worked for …" — the ideal Zed look, but BB has no
  plugin `timeline.append`; would need content-script DOM injection (brittle)
  or a core slot. Deferred.
- **D** composer banner — fixed-position, latest-turn only.
- **E2** dense table, **E3** per-turn cards, **E4** AA-style stacked-column
  chart — panel layout options; E1 chosen, E4 is a good future addition.

## Honesty rules baked into the UI

- tok/s is always "avg" — whole-turn average, not decode speed.
- cost is always "~$/est." — tokens × bundled price table, not provider-billed.
- cached input is one bucket — no read/write split exists in BB's data.
- turns without provider usage show "no usage" instead of zeros.

## Hover-card header (chosen)

V8 structure with V4's duration: `Turn N` + dimmed model stacked on the left,
13px semibold duration right-aligned on the title baseline, metrics row below
(`39.7 tok/s avg · ~$0.06 est.`). Footer is a `TOTAL` label row with the
session in/out/cost values beneath and a dimmed, right-aligned `ⓘ cost
estimated from price table` note — selected from the card-variants mock.

Portal note: the card renders via Radix `HoverCard.Portal` (to escape the
48px header row's stacking context), so every font size inside it is an
inline style — plugin-scoped Tailwind arbitrary values don't exist outside
`[data-bb-plugin]` and silently fall back to the host's base size.

## Icon

`ChartColumn` — the plugin reports token composition and cost stats, not just
speed, so a chart glyph beats the original lightning-bolt idea.
