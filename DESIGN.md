# Design System — Retirement Calculator

## Product Context
- **What this is:** Personal investment portfolio dashboard. Aggregates holdings from Empower into a single view with performance tracking, market signals, and AI attribution.
- **Who it's for:** Single user (developer), Chinese-speaking
- **Space/industry:** Personal finance / investment portfolio management
- **Project type:** Web app / financial dashboard

## Aesthetic Direction
- **Direction:** Terminal Provenance
- **Decoration level:** Minimal — typography and color do all the work. No decorative elements, gradients, or illustrative backgrounds.
- **Mood:** Authority, not delight. Dense and fast. Feels like a Bloomberg terminal built by someone who cares about craft. The data IS the aesthetic. A stranger would find it slightly too dense — that's intentional. It's a single-user instrument.
- **Reference:** Claude subagent design direction proposal, 2026-04-06

## Typography

- **Display/Headers:** Space Grotesk (weight 300–700) — geometric, confident, works at small sizes for dense UI. Used for page titles, section headers, nav labels, button text.
- **Monospace / Numbers:** JetBrains Mono — tabular numerics (no dancing decimals), all financial values, tickers, percentages, period labels, source badges. Weight 400–600.
- **Chinese annotations:** LXGW WenKai — warm Kaiti calligraphy strokes. Deliberate contrast with the cold monospace numerics. Used exclusively for AI attribution text and any Chinese-language annotation. 12–13px, muted color, line-height 1.65.
- **UI Labels:** Space Grotesk 400 for prose labels; JetBrains Mono 400 ALL-CAPS for category labels and period selectors.
- **Loading:** Google Fonts CDN
  ```html
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,600;1,400&family=LXGW+WenKai&display=swap" rel="stylesheet">
  ```
- **Scale:**
  - 10px: micro labels (ALL-CAPS, mono)
  - 11px: tags, source badges, column headers
  - 12px: table body, Chinese annotations, muted secondary
  - 13px: standard UI text, nav items
  - 14px: body default
  - 16px: section titles
  - 22px: stat values (mono)
  - 26px: hero performance number (mono)
  - 32–36px: page display heading

## Color

- **Approach:** Restrained warm dark. No blue, no teal, no purple. One accent (antique gold). Semantic loss color (terra cotta).
- **Background:** `#0E0E0E` — near-black with warmth. Not pure black.
- **Surface:** `#161616` — cards, panels, sidebar content
- **Surface raised:** `#1F1F1F` — hover states, active table rows, focused elements
- **Border / Divider:** `#2A2826` — nearly invisible, warm-tinted
- **Primary text:** `#E8E0D0` — warm off-white, aged paper tone
- **Muted text:** `#6B6460` — desaturated sienna. Used for labels, annotations, secondary data.
- **Gain / Accent:** `#C8A96E` — antique gold. Used for positive returns, primary buttons, the brand wordmark, active nav indicator.
- **Loss:** `#C06B5A` — terra cotta red. Used for negative returns. Not crimson, not pure red.
- **Dark mode:** Dark-only. No light mode. This is a power tool, not a consumer product. Light mode is not implemented.
- **CSS variables:**
  ```css
  :root {
    --bg:      #0E0E0E;
    --surface: #161616;
    --raised:  #1F1F1F;
    --border:  #2A2826;
    --text:    #E8E0D0;
    --muted:   #6B6460;
    --gain:    #C8A96E;
    --loss:    #C06B5A;
  }
  ```

## Spacing

- **Base unit:** 8px
- **Density:** Comfortable on sections, tight on table rows
- **Scale:**
  - 2xs: 2px
  - xs: 4px
  - sm: 8px
  - md: 16px
  - lg: 24px
  - xl: 32px
  - 2xl: 48px
  - 3xl: 64px
- **Table row height:** 32px (tight — data density is the point)
- **Nav item height:** 36px
- **Section padding:** 48px vertical, 24px horizontal (inside dashboard shell)

## Layout

- **Approach:** Single-column, max-width 960px, centered. No sidebar.
- **Header:** Logo (left) + primary nav tabs (投资组合 / 大盘脉搏) + sync log entry point (right, small — icon or text link). Sync log is not a primary nav item.
- **Page structure:** Two top-level pages: 投资组合 for account/holding/performance state, 大盘脉搏 for market signal and DCA decision support. Sync log is a secondary surface, not a peer of these pages.
- **Main content order:**
  1. Total portfolio value + last sync time
  2. Source pills (sync status)
  3. Performance chart — always visible, account level only. Includes firm/account toggle (popover, grouped by firm).
  4. Sub-tab switcher: **按类型** (default) · 按账户 · 按资产
  5. Sub-tab content
- **Sub-tab: 按类型 (default):** Asset class allocation as the primary view. Each class shown as a collapsible row with horizontal allocation bar + percentage. Expandable to show individual holdings within that class.
- **Sub-tab: 按账户:** Account-level rows with balance and percentage of portfolio.
- **Sub-tab: 按资产:** Flat holdings table, sorted by value descending. Drill-down view, not a primary entry point.
- **Sync log:** Accessible via a small entry in the header (right side). Opens as a dedicated full-width section below the header, or a separate page — not a top-level tab. Does not compete with the main dashboard for navigation priority.
- **Max content width:** 960px
- **Border radius:**
  - sm: 4px (tags, period tabs, source badges)
  - md: 6px (inputs, small cards)
  - lg: 8px (section cards, allocation rows)
  - full: 9999px (pills, dots)

## Motion

- **Approach:** Minimal-functional. No entrance animations. No scroll-driven effects.
- **Easing:** ease-out for enter states, ease-in for exit
- **Duration:**
  - Hover/focus transitions: 80–100ms ease-out
  - Row highlight: 80ms
  - Nothing else animates
- **Charts:** Animate once on initial load. No loop, no continuous animation.

## Key Design Decisions

### The inline annotation pattern
AI attribution text (中文) renders directly below the performance number it explains. No modal, no sidebar panel, no badge, no sparkle icon. `LXGW WenKai` 12px, `var(--muted)` color, 1–3 lines. It reads like a handwritten margin note on a brokerage statement. This works because the user IS the primary consumer of the analysis — unlike consumer apps that bury AI features in modals because most users ignore them.

### Asset class first, not individual holdings
按类型 (asset class allocation) is the default sub-tab. Individual holdings (按资产) is a drill-down, not a primary surface — there are too many individual positions to be useful as a default view. Asset class allocation is the mental model the user actually cares about.

### Performance is always visible, always account-level
The performance chart sits above the sub-tabs and does not change when switching between 按类型 / 按账户 / 按资产. It is account-level only — asset-class-level and individual-asset-level performance are not supported and not planned. The firm/account toggle (popover) remains as-is.

### Market Pulse is a peer decision page
大盘脉搏 is a top-level tab because it answers a different daily question than portfolio state: whether new DCA money should stay normal, slow down, or increase. It uses the same dense terminal language, but the visual hierarchy centers confluence, signal zones, normalized index history, and personalized holding notices.

### Market Pulse chart answers two different questions
The Market Pulse chart has two explicit modes: `价格` and `回撤`. `价格` shows SP500/NDX normalized to 100 for trend context; `回撤` shows each index's drawdown from the selected range's running high, not all-time high. This distinction must stay visible in the UI copy as “距区间高点”, because the backend currently serves 5Y price history and the DCA question is usually “is this a pullback window inside the timeframe I am evaluating?”

Short ranges are first-class for DCA timing. The chart supports `1M` alongside 6M/YTD/1Y/3Y/5Y; short-range date ticks use `MM/DD` so the view remains legible on mobile. Avoid abbreviations like `DD` in visible controls; single-user speed still needs labels that are readable the next morning.

### Exposure notices are allocation advice, not ticker trivia
Personalized holding notices should aggregate related exposures before speaking. Technology exposure is surfaced as a group notice across tech funds and tech stocks, while single-stock concentration is surfaced ahead of market-signal notices. When a concentrated single stock already triggers a caution notice, do not also show an individual market-timing notice for the same ticker; contradictory “reduce risk” and “add on opportunity” messages make the DCA instruction less useful.

### Sync log is secondary, not a peer page
Sync log is checked daily but is not as important as portfolio state or market decision support. It lives behind a small header entry point (icon or text link), not a top-level tab. Elevating it to a top-level tab overstates its importance.

### Gold for gains, not green
`#C8A96E` antique gold replaces the ubiquitous green for positive returns. More distinctive, more aesthetically coherent on a dark background, less aggressive than traffic-light green. The category convention (green/red) is a marketing choice for legibility with first-time users — this product has no first-time users.

### Dark-only
No light mode is implemented. Dark is the default and only mode. The warm off-white (`#E8E0D0`) and warm near-black (`#0E0E0E`) reduce eye strain for extended use better than a white background with dark text.

