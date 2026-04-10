# Checkbox Keys: Single Source of Truth

## Problem

Checkbox state is persisted by content-derived keys (e.g. `"Buy milk"`, `"TODO#2"`). The key for each checkbox is computed twice: once in Go (`internal/server/checkbox.go`) using goldmark's AST, and once in TypeScript (`internal/frontend/src/plugins/rehypeCheckboxKeys.ts`) using rehype's HAST. Both extractors must produce byte-identical keys for the same markdown, or overrides are silently lost during `RestoreCheckboxOverrides` (the backend prunes any override whose key is not found in `checkboxSources`).

Two recent drift bugs confirmed this is fragile:

1. goldmark dropped `SoftLineBreak` / `HardLineBreak` markers while rehype preserved them as `\n`.
2. goldmark recursed into every paragraph of a loose list item while rehype only used the first `<p>`.

Both were fixed by patching the Go extractor, but the underlying design — two independent extractors that must agree — will continue to produce these bugs whenever either parser's representation changes.

## Goal

Eliminate text-extraction drift by moving to a single source of truth for checkbox keys. The backend becomes the sole authority; the frontend receives the keys as data and assigns them positionally.

This does not eliminate all possible drift — if goldmark and remark-gfm ever disagree on checkbox document **order** (for example if one handles checkboxes inside blockquotes or tables differently), the Nth backend key could still be attached to the wrong Nth frontend input. Ordering agreement is strictly easier to maintain than byte-identical text agreement, and count mismatches surface as visibly disabled checkboxes rather than silent corruption, but the failure mode is narrowed rather than eliminated.

## Non-Goals

- Changing the key format (content-derived with `#N` disambiguation stays).
- Changing persistence, reconciliation, or API shape beyond adding ordered keys.
- Changing how checkboxes are styled, toggled, or rendered visually.

## Design

### Backend: return ordered keys

`ExtractCheckboxSources` currently returns `map[string]bool`. Go maps have random iteration order, so the JSON serialization cannot be relied on to preserve document order. Replace it with a function that returns both the map and an ordered slice of keys in document order.

```go
// ExtractCheckboxes parses markdown and returns the checkbox sources map
// alongside an ordered slice of keys in document order.
func ExtractCheckboxes(content string) (sources map[string]bool, orderedKeys []string)
```

Add a new field to `State`:

```go
checkboxOrderedKeys map[string][]string // fileID → keys in document order
```

Populate it everywhere `checkboxSources` is populated:

- `AddFile` (`server.go:310-315`)
- `AddUploadedFile` (`server.go:398-403`) — always, not conditional
- `notifyFileChangedByPath` (`server.go:1075-1107`)

Delete it everywhere `checkboxSources` is deleted:

- `RemoveFile` (`server.go:560-561`) — the spec previously missed this cleanup site. Both `checkboxOrderedKeys` and `checkboxOverrides` must be deleted alongside `checkboxSources`.

`ExtractCheckboxSources` is only referenced from within `internal/server/`, so it is deleted outright in favor of `ExtractCheckboxes`.

`GetCheckboxState(id)` changes its signature to return the ordered keys as well:

```go
func (s *State) GetCheckboxState(id string) (sources map[string]bool, overrides map[string]bool, orderedKeys []string, found bool)
```

### API: expose ordered keys

`GET /_/api/files/{id}/checkboxes` response adds `orderedKeys`:

```json
{
  "sources": {"Buy milk": false, "Ship it": true},
  "overrides": {},
  "orderedKeys": ["Buy milk", "Ship it"]
}
```

SSE `checkbox-changed` event payload adds `orderedKeys`. The broadcast helper (`broadcastCheckboxChanged`) and its single caller in `notifyFileChangedByPath` take the ordered keys as a parameter.

### Frontend: simplify the rehype plugin

`rehypeCheckboxKeys.ts` is replaced with `rehypeCheckboxIndices.ts` (or the file is kept and simplified — implementation choice). The new plugin takes `orderedKeys: string[]` as an option and assigns the Nth key to the Nth checkbox input encountered during HAST traversal. All text extraction and key computation is deleted.

The plugin must only count checkboxes that are inside a GFM task list item (parent `<li class="task-list-item">`). This matches goldmark's TaskList scope and prevents raw HTML `<input type="checkbox">` elements (via `rehypeRaw`) from shifting the index. Without this filter, a markdown document like:

```markdown
<input type="checkbox"> raw html

- [ ] real task
```

…would cause the plugin to assign the first backend key to the raw HTML checkbox and leave the real task unkeyed.

```typescript
interface RehypeCheckboxIndicesOptions {
  orderedKeys: string[];
}

export function rehypeCheckboxIndices({ orderedKeys }: RehypeCheckboxIndicesOptions) {
  return (tree: Root) => {
    let index = 0;
    visit(tree, "element", (node: HastElement, _i, parent) => {
      if (node.tagName !== "input" || node.properties?.type !== "checkbox") {
        return;
      }
      // Only task-list checkboxes get keys. Raw HTML checkboxes and checkboxes
      // outside a GFM task list item are ignored — matching the backend's scope.
      const parentEl = parent as HastElement | null;
      if (!parentEl || parentEl.type !== "element") return;
      const isTaskListItem =
        parentEl.tagName === "li" &&
        typeof parentEl.properties?.className === "object" &&
        Array.isArray(parentEl.properties.className) &&
        parentEl.properties.className.includes("task-list-item");
      // Loose lists wrap the checkbox in a <p>, so also check the grandparent.
      // Implementation detail: the plugin must walk up one level when parent is <p>.
      if (!isTaskListItem) {
        // Check if parent is a <p> inside a task-list-item <li>.
        // Exact ancestor-walking logic is left to the implementer but the
        // invariant is: assign keys only to checkboxes whose nearest <li>
        // ancestor has class "task-list-item".
        return;
      }
      if (index < orderedKeys.length) {
        node.properties = node.properties ?? {};
        node.properties["dataCheckboxKey"] = orderedKeys[index];
      }
      index++;
    });
  };
}
```

Deleted from the frontend:

- `extractHastText` function
- `computeCheckboxKey` function
- `RehypeCheckboxKeysOptions.onCheckboxMap` (unused in production)
- Test cases in `rehypeCheckboxKeys.test.ts` that cover text extraction and key computation
- The `<p>`-unwrapping logic for loose lists (no longer needed)

New frontend tests cover the index-assignment behavior: assigning keys in order, handling count mismatches, skipping non-checkbox inputs.

### Frontend: plumb ordered keys through state

`useCheckboxState` stores ordered keys alongside sources and overrides. The hook's return value adds `orderedKeys: string[]`. The initial fetch, the SSE-dispatched update, and the `CheckboxState` API type all gain this field.

The `useSSE` hook's `onCheckboxChanged` callback type (`useSSE.ts:6-11`) gains an `orderedKeys` parameter, and `App.tsx`'s `onCheckboxChanged` handler (`App.tsx:210-216`) forwards it through the `mo-checkbox-changed` custom event payload.

`MarkdownRenderer.tsx` reads `orderedKeys` from `useCheckboxState` and passes it into the rehype plugin as an option:

```typescript
rehypePlugins={[
  rehypeRaw,
  [rehypeCheckboxIndices, { orderedKeys }],
  // ...
]}
```

Because `orderedKeys` is now a render-time input to the plugin, it must be included in the `renderedContent` useMemo dependency array. The existing `checkboxRevision` dependency (used to force re-render when `sources`/`overrides` change without content changing) is **kept** — `orderedKeys` supplements it rather than replacing it.

### Frontend: render-gating to avoid first-paint flicker

Currently, the rehype plugin is self-sufficient — it computes keys from the HAST during the first render, so checkboxes always render interactively on first paint. Under the new design, `orderedKeys` is loaded asynchronously via `fetchCheckboxes`. There is a window between "content has loaded and rendered" and "orderedKeys has arrived" during which every checkbox would render without a `data-checkbox-key` and the `input` component would render them as disabled (`MarkdownRenderer.tsx:569-572`). When keys arrive the tree re-renders with correct state, producing a visible flicker that the current implementation does not have.

To prevent this, `useCheckboxState` adds a `checkboxesLoaded: boolean` field that flips to `true` after the first `fetchCheckboxes` resolves (whether it succeeds or fails). `MarkdownRenderer` gates rendering on this flag:

```typescript
if (!checkboxesLoaded) {
  // Keep showing previous content (or a neutral placeholder) until keys arrive.
  return previousRendered ?? null;
}
```

The exact placeholder strategy is left to the implementer, but the invariant is: the markdown tree must not render any task-list checkboxes before `orderedKeys` has arrived for the current file. On file switch (`fileId` changes), `checkboxesLoaded` resets to `false` and re-flips after the new fetch resolves.

### Safety: count mismatch behavior

Because the plugin only assigns keys to checkboxes inside `<li class="task-list-item">`, raw HTML checkboxes (`<input type="checkbox">` emitted by `rehypeRaw`) are skipped entirely and do not shift the index. This matches goldmark's TaskList extension scope.

Within the task-list scope, if goldmark and remark-gfm ever disagree on checkbox count, the plugin assigns keys up to `orderedKeys.length` and leaves additional checkboxes without a `data-checkbox-key`. The existing `input` component already handles this case — unkeyed checkboxes render disabled (`MarkdownRenderer.tsx:569-572`). This is a visible, debuggable failure mode rather than a silent key mismatch.

Test cases should include checkboxes inside blockquotes and tables, which are the most likely sources of future parser-order disagreement.

## Data Flow

```
File on disk
     │
     ▼
 goldmark parse ──► ExtractCheckboxes ──► (sources, orderedKeys)
                                              │
                                              ▼
                                      State.checkboxSources
                                      State.checkboxOrderedKeys
                                              │
                                              │ GET /_/api/files/{id}/checkboxes
                                              │ SSE checkbox-changed
                                              ▼
                                  useCheckboxState (frontend)
                                       { sources, overrides, orderedKeys }
                                              │
                                              ▼
                              rehypeCheckboxIndices({ orderedKeys })
                                              │
                                              ▼
                                  <input data-checkbox-key="...">
```

## Migration

This is not a backward-compatible change to the backup format or API shape as wire data — the response gains a field, but existing fields stay the same. Old backups without `orderedKeys` stored continue to work: `orderedKeys` is computed from the file on disk at startup (via `ExtractCheckboxes`), so it's always fresh.

Clients that don't send `orderedKeys` in their fetch response (i.e. stale frontend code against a new backend) simply see the plugin fall back to assigning no keys — checkboxes render as disabled until the frontend is rebuilt. There's no risk of key corruption because keys aren't being computed on the frontend anymore.

## Testing

### Backend

- Existing `TestExtractCheckboxSources` is renamed/adapted to `TestExtractCheckboxes` and asserts both the map and the ordered slice.
- New assertion: ordered keys reflect document order (including duplicate disambiguation).
- Existing `TestHandleGetCheckboxes`, `TestHandlePutCheckbox`, `TestHandleDeleteCheckboxes`, `TestHandleCheckAll`, `TestCheckboxReconciliationOnFileChange`, `TestRestoreCheckboxOverrides` updated to account for the new `orderedKeys` field in responses and state.

### Frontend

- `rehypeCheckboxKeys.test.ts` is replaced with `rehypeCheckboxIndices.test.ts`. New cases:
  - Assigns keys in document order
  - Handles fewer keys than checkboxes (excess checkboxes get no key)
  - Handles more keys than checkboxes (excess keys are ignored)
  - Ignores non-checkbox inputs
  - Ignores raw HTML checkboxes outside a task-list-item (does not shift the index)
  - Preserves existing `data-*` attributes on inputs

### Cross-parser ordering

- New backend test: checkbox inside a blockquote — verify both parsers agree on inclusion and order.
- New backend test: checkbox inside a table cell (if GFM task lists are valid in that context) — same.
- New frontend test: markdown with both a task-list item and a raw HTML checkbox — the plugin must attach the backend key to the task-list item, not the raw HTML one.

## Files Touched

- `internal/server/checkbox.go` — delete `ExtractCheckboxSources`, add `ExtractCheckboxes` returning `(map, []string)`
- `internal/server/checkbox_test.go` — adapt tests to the new signature
- `internal/server/server.go`:
  - new `checkboxOrderedKeys map[string][]string` field on `State`
  - updated `GetCheckboxState` signature
  - updated `handleGetCheckboxes` JSON response
  - updated `broadcastCheckboxChanged` to include ordered keys
  - `AddFile`, `AddUploadedFile`, `notifyFileChangedByPath` all populate `checkboxOrderedKeys`
  - `RemoveFile` deletes `checkboxOrderedKeys[id]`
- `internal/server/server_test.go` — adapt checkbox-related tests
- `internal/frontend/src/plugins/rehypeCheckboxKeys.ts` — rewrite as index-assigning plugin (rename to `rehypeCheckboxIndices.ts`); delete `extractHastText`, `computeCheckboxKey`, and the loose-list `<p>` unwrapping logic
- `internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts` — rewrite tests (also renamed)
- `internal/frontend/src/hooks/useApi.ts` — add `orderedKeys: string[]` to `CheckboxState` type
- `internal/frontend/src/hooks/useSSE.ts` — `onCheckboxChanged` callback signature adds `orderedKeys`
- `internal/frontend/src/hooks/useCheckboxState.ts` — store and return `orderedKeys`; add `checkboxesLoaded` flag; listen for `orderedKeys` on the `mo-checkbox-changed` custom event
- `internal/frontend/src/App.tsx` — forward `orderedKeys` from SSE callback into the `mo-checkbox-changed` event detail
- `internal/frontend/src/renderers/MarkdownRenderer.tsx` — pass `orderedKeys` to plugin, add to `renderedContent` dependencies (alongside existing `checkboxRevision`), gate markdown rendering on `checkboxesLoaded`

### Files NOT touched

- `cmd/root.go` — startup restore path only handles overrides; ordered keys are always recomputed from disk at file-add time, so no migration logic is needed
- `internal/backup/` — backup format is unchanged; `orderedKeys` is not persisted
- `MarkdownRenderer.tsx` `sanitizeSchema` (line 30) — already allowlists `dataCheckboxKey` on `input`, no change needed
