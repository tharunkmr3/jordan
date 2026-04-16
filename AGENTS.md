<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## UI conventions

### Use optimistic UI everywhere

Any user action that mutates data (create / update / delete / upload) MUST update the UI immediately, before the server round-trip completes. Pattern:

1. Update local state synchronously with the expected result.
2. Dispatch a cross-component event if other parts of the UI hold copies of this data (e.g. sidebar agents list).
3. Fire the API request in the background.
4. On success: replace local optimistic state with the server's authoritative response (usually a no-op, but required when the server fills in derived fields like `avatar_url` with a CDN path, `id`, `created_at`, etc.).
5. On failure: roll back local state and surface an error toast.

**Cross-component updates:** use a `CustomEvent` dispatched on `window`. The receiving component listens with `addEventListener` inside `useEffect`. Example event names in use:
- `agent-updated` — `{ id, name?, status?, avatar_url? }` — sidebar merges these into its local list
- `refresh-agents` — no payload — forces sidebar to refetch
- `toggle-sidebar` — no payload — collapses/expands sidebar from anywhere

When you add a new mutation, check every other screen that displays the same entity and make sure it updates. No user should ever need to refresh the page or navigate away and back to see their own action reflected.

### Scrollbars: hover-only, subtle

Scrollbars are globally styled in `globals.css`:
- **Hidden by default** (`scrollbar-width: none`)
- **Visible on hover** — thin (5px), barely-there (`rgba(0,0,0,0.12)`), fully rounded
- Both Firefox (`scrollbar-width`/`scrollbar-color`) and Webkit (`::-webkit-scrollbar`) are handled

Never add custom scrollbar overrides per component. If a section scrolls, it gets the hover-reveal behavior automatically. Do not use `overflow: overlay` (deprecated).

### Font sizes: accessibility minimum

Use these size tiers consistently:
- **Body/labels:** `text-sm` (14px) — minimum for readable UI text
- **Descriptions/helper text:** `text-xs` (12px)
- **Tiny hints (timestamps, shortcuts):** `text-[11px]` — absolute minimum
- **Page titles:** `text-base` (16px) or larger
- **Section headers:** `text-sm font-semibold` (14px bold)

Never go below 11px for any visible text. Prefer `text-sm` (14px) as the default body size. Use Tailwind preset classes (`text-xs`, `text-sm`, `text-base`) over arbitrary values when possible.

### Cursor: pointer on all clickable elements

Global CSS in `globals.css` sets `cursor: pointer` on `button`, `a`, `[role="button"]`, `select`, `summary`, `label[for]`, and input submit/button types. Never add `cursor-pointer` manually in Tailwind — it's handled globally. If a custom div or span is clickable, give it `role="button"` or use a `<button>` element.

### Text color: softened black

Use `#2e2e2e` for primary text — not pure `#000` or harsh `#0a0a0a`. The extra brightness is tiring on eyes. Secondary text stays at `#525252` / `#737373`, tertiary/hint at `#a3a3a3`. Avoid introducing new shades; pick from the existing palette.

### Text casing: no uppercase except abbreviations

Never use `uppercase` Tailwind class or manual ALL-CAPS strings in UI labels. Section headers, form labels, button text, nav items — all use sentence case. The only exception is genuine abbreviations (ISO codes like EN/HI, acronyms like AI/API/URL/ID). Use `font-semibold`/`font-medium` + color for hierarchy instead of uppercase.

### Brand color: deep orange (#F4511E)

Defined in `globals.css` as `--color-brand: #F4511E` and `--color-brand-soft: #FFF4EE`. Use sparingly as an accent — NOT as a fill color for large surfaces.

Currently applied to:
- Active tab underlines (`border-[#F4511E]`) — agent settings tabs, inbox Details/Copilot tabs
- Panel resize handle on hover

Never use brand orange for primary CTAs, icons, or body text. The primary CTA stays black (`bg-black` / `bg-primary`). If a new accent need arises, ask before introducing a second brand shade.

### Panel and Card primitives

Two distinct elevation primitives, each with a clear role:

- **`<Panel>`** (`src/components/ui/panel.tsx`) — page-level container. White rounded card with an optional 48px header slot and an optional drag-to-resize right edge. Use for the big chrome of a page: inbox's three columns, agent settings' form + test chat, etc. Supports `resizable`, `defaultWidth`, `minWidth`, `maxWidth`, and `storageKey` for persisting width across reloads. Import `<PanelTitle>` / `<PanelActions>` helpers if the header is a simple title + actions pair.

- **`<Card>`** (`src/components/ui/card.tsx`) — content block inside a page. Same elevation style but lighter weight. Exposes a `size` prop with tiers `xs | sm | md | lg | xl` that drives:
  - `py` + `gap` on the Card itself (e.g. `md` → `py-4 gap-4`)
  - `px` on `CardHeader` / `CardContent` / `CardFooter` (e.g. `md` → `px-4`)
  - Auto horizontal padding when a direct `<Table>` child is present
  - A nudge to `CardTitle` font size at the extremes (`xs/sm` → `text-sm`, `xl` → `text-lg`)

  Default is `md`. Use `sm` for single-metric / stat cards, `xs` for chip-dense tiles, `lg`/`xl` for feature or hero cards. **Never write hand-rolled padding like `<CardContent className="p-5">`** — pick the right size tier instead.

**Elevation style for both:** soft shadow, no ring. Panel uses a two-layer drop shadow; Card uses a single subtle shadow + a `black/[0.04]` hairline ring. Never add `ring-1 ring-black/[0.06]` — that's the old darker look. For any new white-surface rounded container, use `<Card>` or `<Panel>` instead of a raw `<div>`.

### Borders: subtle, `black/[0.04]`

All panel borders, card hairlines, table dividers, and intra-panel dividers use `border-black/[0.04]` (or `ring-black/[0.04]`). Never `black/[0.06]` or darker. Internal dividers inside a panel header can go to `border-black/[0.03]` if they compete with content.

### Tables: no lines, first column auto-medium

`<Table>` (`src/components/ui/table.tsx`) is borderless by default:
- No `border-b` on header, rows, or footer
- `border-separate border-spacing-0` so rows sit flush
- Header: `h-9 text-xs font-medium text-[#737373]` — reads as a quiet label row, not a divider
- Body cells default to `text-[#525252]`, but **the first `<TableCell>` in each row automatically becomes `font-medium text-[#2e2e2e]`** — the leading column is the row's "name". Override per-cell only when needed.
- Hover tint is `#fafafa`

Never add row dividers. Never add `font-medium` to the first cell manually — it's already applied.

### Header slot: `<HeaderActions>`

The layout header exposes a portal slot (`#page-header-actions`) on the right side. Any page can mount filters, action buttons, or other controls there by wrapping them in `<HeaderActions>` from `src/components/ui/header-actions.tsx`. Use this instead of:
- Adding `pathname === "/foo"` branches to the layout (no)
- `CustomEvent` bridges to tell the layout to render a button (no)

State stays in the page; the portal keeps UI composition clean.

Example chip-style selects for header filters (rounded, subtle border):
```tsx
<SelectTrigger className="h-8 rounded-lg border-black/[0.06] text-[13px]">
```

### Icon weight: Phosphor `bold` by default

Phosphor icons in the `(app)` tree default to `weight="bold"` via `<IconContext.Provider>` wrapping `AppLayout`. Do not set `weight="regular"` — it's redundant and lighter than the rest of the app. Override only for:
- Logos / channel icons → `weight="fill"` (colored badges)
- Empty-state illustrations → `weight="duotone"`
- Active states of toggleable icons (e.g. starred) → `weight="fill"`

Lucide icons (for shadcn primitives and forms) stay at stroke-width `2` — this is set globally in `globals.css` via `svg.lucide { stroke-width: 2 }`. Don't set `strokeWidth` per-icon.

### Buttons: secondary by default, outline only on grey backgrounds

Two non-primary Button variants:

- **`variant="secondary"`** (`bg-[#ebebeb]` / `hover:bg-[#e0e0e0]`, no border) — use this for every secondary action on a **white** surface: inside Cards, Panels, Dialogs, the main page shell. This is the default choice for non-primary buttons (Cancel, Edit, Upload, Copy, Link Existing, OAuth buttons on white auth pages, etc.).
- **`variant="outline"`** (`bg-background` + `border-black/[0.06]`) — use this only when the button sits directly on a **grey** surface (sidebar, `bg-[#f5f5f5]` page backgrounds, hover states over grey). The subtle border is what gives it presence on grey; a secondary chip would blend into the background.

Primary CTA stays `variant="default"` (black / `bg-primary`). Destructive stays `variant="destructive"`. Ghost stays `variant="ghost"` for icon-only or in-table actions.

When in doubt: if the button is inside a white `<Card>` / `<Panel>` / `<Dialog>`, use `secondary`. Don't reach for `outline` unless you've actually placed the button on a grey surface.

### Sidebar row alignment

Every sidebar row (nav item, search, New Agent, agent list, user menu) uses:
```tsx
className="flex items-center gap-3 rounded-md px-3 py-2 text-[13px] leading-none font-medium"
```

`leading-none` is critical — without it the text's line-height makes its optical center sit below the icon's. Active row uses `bg-white text-[#2e2e2e] shadow-[0_2px_4px_-1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.04)]` — a bottom-biased drop shadow, no ring. Inactive icon is `#737373`; active icon is `#525252` (not `#2e2e2e` — the label carries the strongest text).
