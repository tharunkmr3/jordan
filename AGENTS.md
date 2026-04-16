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
