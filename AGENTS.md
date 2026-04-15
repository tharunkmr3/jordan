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
