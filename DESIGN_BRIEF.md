# UI/UX Redesign — Elite Tier
**Finance Management PWA · Harutyunyan Family**

- **Scope:** Full product redesign
- **Stack constraint:** Plain HTML / CSS / JS — no framework
- **Users:** 1 family, ~4 people, mobile-first
- **Data:** 82 obligations · live API · AMD ֏

---

## Current State — What's Broken

| Area | Problem |
|------|---------|
| Visual | No design system. Colors, spacing, and type are inconsistent across cards, tables, and modals. The sidebar logo is a letter "F". |
| Information | Wrong hierarchy. 82 obligations shown as a flat list. No urgency. No sense of what needs attention today vs. this month. |
| Interaction | Zero feedback on action. Tapping "Done" produces no satisfying animation. Saving a balance shows no confirmation. Actions feel dead. |
| Mobile | Broken on small screens. Table columns collapse poorly on 375px. Loan cards are too wide. Balance inputs require pixel-perfect tapping. |
| Cognition | No decision support. User sees 82 rows and must calculate mentally what is urgent. No "3 loans due this week" summary. |
| Emotion | Feels like a spreadsheet. Finance apps should feel calm and in-control. No delight, no reward for paying off a loan. |

---

## Task 1 — Design Token System
**Priority: P1 · Estimate: 3 days · Type: Foundation**

Before a single pixel changes, define every value in CSS custom properties. This is the foundation. Every other task draws from it.

- **Color scale:** neutral (12 steps), primary blue, destructive red, success green, warning amber — each as a semantic token (`--color-surface-1`, `--color-text-muted`, etc.) not a raw hex
- **Typography scale:** 6 sizes (10 / 12 / 13 / 15 / 18 / 24px) with matching line-heights and weights. One typeface: Inter. No exceptions.
- **Spacing scale:** 4px base unit — 4, 8, 12, 16, 20, 24, 32, 48px only. No arbitrary values in the codebase.
- **Border radius:** 4px for inputs/chips, 10px for cards, 16px for modals, 999px for pills
- **Shadow:** 3 levels — inset (inputs), flat (cards), elevated (modals)
- **Motion:** define duration tokens (80ms snap, 160ms standard, 320ms enter/exit) and easing (ease-out for enters, ease-in for exits)
- **Dark mode:** every token has a light and dark value via `@media (prefers-color-scheme: dark)`. Finance apps are used at night.

---

## Task 2 — Today Surface — Command Center
**Priority: P1 · Estimate: 4 days · Type: IA Redesign**

The first screen the user sees when they open the app. Currently called "Dashboard" with 4 stat cards. It must become a command center that tells the user exactly what to do today.

- **Hero section:** single large number — "Total due this month: 12,450,000 ֏" — with a sub-line showing how many are paid vs unpaid today
- **Urgent strip:** horizontally scrollable row of "overdue" and "due within 3 days" cards. Red border on overdue. Each card tappable → jumps to that payment in the Schedule.
- **Progress ring:** large animated SVG ring showing month completion percentage. Animates from 0 to current on page load (320ms ease-out). Not a bar — a ring feels alive.
- **Payer breakdown:** vertical bar chart showing each family member's total obligation and how much is paid. Bars fill with animation on render.
- **Net cashflow card:** Income minus obligations, colored green if positive, red if negative. Largest single financial signal in the app.
- Remove the "By Category" doughnut chart from the main view — it answers a question nobody asks at 8am.

---

## Task 3 — Payment Row — Micro-interaction Design
**Priority: P1 · Estimate: 2 days · Type: Interaction**

Marking a payment done is the #1 daily action in this app. It must feel satisfying — not like updating a spreadsheet.

- Replace the "✓ Done" button with a large tap target (44×44px minimum) checkbox-style toggle. On mobile this is the entire right third of the row.
- **On mark-paid:** row background transitions to subtle green tint (80ms). Text mutes to 40% opacity (160ms, staggered 40ms after). Tiny checkmark scales in from 0 to 1 (120ms spring).
- **On undo:** reverse the sequence. The row "wakes up" — opacity restores before background clears.
- **Overdue indicator:** left border 3px red on any payment whose dueDay has passed and is still unpaid. No label needed — the color communicates.
- **Due-soon indicator:** left border 3px amber for payments due in the next 3 days.
- **Swipe-to-pay on mobile:** swipe right on a row to mark paid. Reveals a green check behind the row as you swipe. Full swipe confirms. Partial swipe snaps back.

---

## Task 4 — Loan Card — Full Redesign
**Priority: P2 · Estimate: 3 days · Type: Component**

The current loan cards are functional but visually flat. Each card holds significant financial data. It should feel like a premium financial product card.

- **Card header:** bank name large (16px bold) with a colored initial avatar (unique color per bank, auto-generated from name hash). Payer name as secondary.
- **Progress arc:** replace the flat progress bar with a compact SVG arc (half-circle, 120px wide). Filled in the brand color to show % paid off. Number in the center.
- **Balance vs total:** display as "570,000 ֏ of 600,000 ֏ remaining" in a single clean line rather than separate label + input + button.
- **Edit mode:** tapping "Edit" slides in an inline edit panel below the card header (not a modal). Fields appear with a subtle slide-down (160ms). Save collapses them.
- **Unverified state:** dashed border on the entire card (not just a warning line). The card is visually "incomplete" until a balance is saved.
- **Contract number:** monospace font, subtle background, tap-to-copy with haptic feedback (`navigator.vibrate(10)`) on mobile.
- **Paid-off celebration:** when balance reaches 0, card shows a brief green pulse and "Paid off" badge. One moment of delight per loan.

---

## Task 5 — Navigation — Mobile Bottom Sheet
**Priority: P2 · Estimate: 2 days · Type: Layout**

The current mobile nav is 5 icon tabs at the bottom. Structurally fine but the icons are unicode characters (☰ ◈ ⊟) and the active state is barely visible.

- Replace unicode icons with inline SVG icons — 20×20px, 1.5px stroke, single path. Custom icon for each tab.
- **Active tab:** filled icon + label visible + indicator dot above the icon. Inactive: outline icon, no label. Standard iOS/Android pattern users already understand.
- **Active tab transition:** icon morphs from outline to fill using CSS clip-path animation (80ms). Indicator dot scales in from 0 (spring, 120ms).
- **Desktop:** keep the sidebar but add "collapse to icons" mode at 900px breakpoint. Expand on hover/click.
- The current sidebar logo ("F" in a box) should be the AMD symbol ֏ styled in the brand gradient — this app is about Armenian drams, make it feel Armenian.

---

## Task 6 — Loading & Empty States
**Priority: P2 · Estimate: 1 day · Type: Polish**

The current loading state is a spinning circle over the entire app that disappears instantly, creating a jarring flash.

- **Skeleton screens:** instead of a loading overlay, render the skeleton of each section immediately. Stat card skeletons (grey pulsing rectangles) while data loads. Table row skeletons for the payment list.
- **Skeleton animation:** background-position shimmer (CSS @keyframes, 1.4s linear infinite). Classic pattern — not a spinner.
- **Staggered reveal:** when data arrives, rows fade in with staggered delay (30ms per row, max 200ms total). The table "fills in" rather than appearing all at once.
- **Error state:** full-screen error with an icon, clear message ("Could not connect to Google Sheets — check your connection"), and a Retry button. Not a toast that disappears in 5 seconds.
- **Empty schedule:** when all payments for the month are done, show a celebratory illustration (simple SVG checkmark with subtle glow) and "All payments done for June ✓".

---

## Task 7 — Typography & Color — Final Pass
**Priority: P2 · Estimate: 1 day · Type: Visual**

A single day of applying the token system ruthlessly. Every text size, every color, every spacing value audited and corrected.

- Audit every `font-size` in style.css. Any value not in the type scale is a bug. Fix all of them.
- Amount numbers use `font-variant-numeric: tabular-nums` so AMD values align in columns without layout shift.
- Payer name colors: currently hardcoded as CSS classes (`.p-Hovhannes`, etc.). Replace with a single CSS variable set dynamically from JS, using the same PALETTE array already in app.js.
- Page headers: increase to 22px, reduce font-weight from 700 to 600 — heavy headers feel aggressive. Let whitespace carry the hierarchy.
- Table: remove the alternating hover background — too subtle to perceive. Increase row padding to 11px 12px and let the border do the separation work.
- Button hierarchy: there are currently 6 different button styles (btn-save, btn-edit, btn-add, btn-nav, btn-today, check-btn). Consolidate to 3: **Primary, Secondary, Ghost**.

---

## Task 8 — Accessibility Audit
**Priority: P3 · Estimate: 1 day · Type: Quality**

- All interactive elements: minimum 44×44px touch target (WCAG 2.5.5 AAA). The current "Save" balance button is ~28px tall.
- Color contrast: all text must pass WCAG AA (4.5:1 for body, 3:1 for large). The current `--muted` color (#64748b on white) fails at small sizes.
- Focus states: every button and input must have a visible `:focus-visible` ring (2px solid, offset 2px). Currently missing on check-btn and copy-chip.
- Screen reader: `aria-label` on all icon-only buttons. The "‹" and "›" month navigation buttons are currently unlabelled.
- Modal: focus must be trapped inside the loan edit modal when open. Currently tabbing out of the modal closes nothing.
- Error announcements: when an API call fails, announce it via a live region (`aria-live="polite"`) not just a visual toast.

---

## Task 9 — PWA & Performance Polish
**Priority: P3 · Estimate: 1 day · Type: Engineering**

- **Offline mode:** SW currently returns `{"error":"offline"}`. Instead, cache the last successful API response and serve stale data with an "Offline — showing data from [date]" banner.
- **Install prompt:** intercept `beforeinstallprompt` and show a custom "Add to Home Screen" banner after the second visit. Current app never prompts for installation.
- **Dark mode:** implement using the token system from Task 1. Finance apps are used at midnight when someone is worrying about debt.
- **Reduce paint:** Chart.js loads 200kb of JS for 2 charts. Replace with hand-rolled SVG charts and remove the Chart.js dependency entirely.
- **Touch events:** replace all `onclick` with pointer events for unified mouse+touch handling with no 300ms delay.

---

## Design Principles — Non-negotiable

**Speed is a feature**
Every interaction must feel instant. Optimistic UI everywhere — update state before the API responds, roll back on error. Never show a spinner where a skeleton will do.

**One primary action per screen**
Dashboard → see what's urgent. Payments → mark things done. Loans → update balances. Each tab has one job. Anything that distracts from that job is removed.

**Spacing does the work**
Do not use background colors, borders, or dividers to separate content if generous whitespace can do it. Cards should breathe. Density is earned by familiarity, not assumed by default.

**Dark-first design**
Finance is anxiety. A dark app at midnight is calmer than a bright one. Design in dark mode first, then adapt to light. Not the other way around.

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Time to first meaningful paint (4G) | < 2 seconds |
| WCAG AA contrast failures | 0 |
| Minimum tap target size | 44×44px |
| Total button variants | 3 (Primary / Secondary / Ghost) |

---

## Visual References — Study, Don't Copy

| App | What to steal |
|-----|--------------|
| Linear | Information density, keyboard-first feel |
| Stripe Dashboard | Data trust, type hierarchy |
| Apple Wallet | Card design, transaction feel |
| Vercel Dashboard | Dark mode done right |
| Monzo | Delight without noise |
| Mercury | Calm finance aesthetic |
