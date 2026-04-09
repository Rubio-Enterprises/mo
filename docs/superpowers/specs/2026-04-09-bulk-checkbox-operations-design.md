# Bulk Checkbox Operations Design

**Goal:** Add clickable checkbox labels, shift-click range selection with bulk check/uncheck, and a "Check All" operation to complement the existing "Uncheck All."

**Scope:** Single-file checkbox operations only. Multi-file bulk operations and undo support are out of scope.

---

## Feature 1: Clickable Checkbox Labels

The `<li>` element containing a task checkbox becomes a click target. Clicking anywhere on the list item text (not just the `<input>`) toggles the checkbox.

### Implementation

In `MarkdownRenderer.tsx`, add a component override for `li` that:

1. Detects if the list item is a task item by checking for the `task-list-item` class that remark-gfm adds. This distinguishes task list `<li>` from regular `<li>` elements.
2. Finds the child `<input>` with `data-checkbox-key` to extract the key.
3. Attaches an `onClick` handler to the `<li>` that calls `toggle(key)`.
4. Prevents double-toggle: the `<input>` click handler calls `e.stopPropagation()` so the `<li>` handler doesn't also fire.

### Visual Feedback

- `cursor: pointer` on task list items.
- Subtle hover highlight (`bg-gh-bg-hover` with rounded corners) on the `<li>`.

### Edge Cases

- **Links inside labels:** Clicking an `<a>` tag should navigate, not toggle. The `onClick` handler walks up from `e.target` to the `<li>` — if any ancestor is an `<a>`, bail out.
- **Code spans and inline elements:** These toggle when clicked (they are part of the label).
- **Text selection:** Add `user-select: none` to task list `<li>` elements to prevent accidental text selection on click. Users can still select text in non-task list items.

---

## Feature 2: Shift-Click Range Selection

Shift+clicking a checkbox or its label text selects a range of checkboxes. A floating action bar appears for bulk operations.

### Selection Mechanics

| Interaction | Behavior |
|-------------|----------|
| Normal click (no modifier) | Toggle that single checkbox immediately |
| Shift+click (no anchor set) | Sets the anchor. The anchor item is visually highlighted but the action bar does not appear yet. |
| Shift+click (anchor set) | Selects everything between anchor and target (inclusive). Action bar appears. |
| Shift+click (range exists) | Clears previous range, sets new anchor (single highlight, no action bar) |
| Escape | Clears selection and anchor |
| Click outside task list items | Clears selection and anchor |
| Ctrl/Cmd+click | Out of scope for initial implementation |

**"Click outside" definition:** A document-level `mousedown` handler checks whether the event target is inside a `<li>` with `task-list-item` class, the `SelectionActionBar`, or the `CheckboxActionsButton`. If not, clear selection.

### Visual Treatment

- Selected `<li>` elements (including anchor-only state) get a background highlight (e.g., `bg-blue-50 dark:bg-blue-900/20`) and a left border accent.
- The checkbox `<input>` itself is not visually changed — the highlight is on the `<li>`.

### Floating Action Bar (`SelectionActionBar`)

- Rendered by `FileViewer` (not inside `MarkdownRenderer`), positioned fixed at the bottom of the content area so it does not scroll with the article.
- Appears when 2+ checkboxes are selected. Conditionally rendered (not CSS-hidden).
- Content: **"N of M selected"** — **Check** | **Uncheck** | **Cancel** (where M is total checkbox count).
- Styled to match GitHub theme (border, subtle shadow, rounded).
- Auto-focuses when it appears for keyboard accessibility. Buttons reachable via Tab.
- "Cancel" clears selection and dismisses the bar.
- "Check" / "Uncheck" calls the batch endpoint with the selected keys and explicit `checked: true` or `checked: false`, then clears selection.

### State Management

- `useCheckboxSelection` hook lives in `FileViewer`, not `MarkdownRenderer`. Selection callbacks (`onShiftClick`, `isSelected`) are passed down to `MarkdownRenderer` as props.
- Selection state is local (React `useState`) — transient UI, not persisted or synced.
- Range calculation uses document order of `[data-checkbox-key]` elements in the DOM, queried via `articleRef`.

---

## Feature 3: Check All and Batch Endpoints

Two new server endpoints: one for "check all" (complement to "uncheck all") and one for batch operations on a selection.

### Check All API

`POST /_/api/files/{id}/checkboxes/check-all`

- Returns `204 No Content` on success.
- Returns `404 Not Found` if the file ID is unknown.
- Broadcasts a `checkbox-changed` SSE event.

**Server logic (`State.CheckAll`):** For each checkbox key in `checkboxSources[id]`:
- If source is `true`: remove any override (already checked).
- If source is `false`: set `override = true`.

Same pattern as `UncheckAll` but inverted.

### Batch API

`POST /_/api/files/{id}/checkboxes/batch`

- Body: `{"keys": ["key1", "key2", ...], "checked": true|false}`
- Returns `204 No Content` on success.
- Returns `404 Not Found` if the file ID is unknown.
- Broadcasts a single `checkbox-changed` SSE event (not one per key).

**Server logic (`State.SetCheckboxBatch`):** For each key in the request:
- If `checked` matches source value for that key: remove any override.
- If `checked` differs from source: set override.
- Keys not present in `checkboxSources` are silently ignored.

This avoids the race condition of calling N individual PUTs — the action bar sends one request with explicit `checked` values instead of using `toggle()`.

---

## Feature 4: CheckboxActionsButton Dropdown

Replace the existing `UncheckAllButton` with a dropdown button offering both "Check All" and "Uncheck All."

### Behavior

- Single button in the right action bar (same position as current `UncheckAllButton`).
- Click opens a small dropdown menu with two items: "Check All" and "Uncheck All."
- Follows the same dropdown pattern as `CopyButton`.
- Only appears when the file has checkboxes (`hasCheckboxes === true`).

---

## Component Changes

### Modified

| Component | Change |
|-----------|--------|
| `MarkdownRenderer.tsx` | `li` override for clickable labels; shift-click detection delegates to selection callbacks from props; selection highlighting via `isSelected` prop |
| `FileViewer.tsx` | Swap `UncheckAllButton` for `CheckboxActionsButton`; host `useCheckboxSelection` hook; render `SelectionActionBar`; pass selection callbacks to `MarkdownRenderer` |
| `useCheckboxState.ts` | Add `checkAll()` function; include it in return value |
| `useApi.ts` | Add `checkAllCheckboxes(id)` and `batchSetCheckboxes(id, keys, checked)` functions |
| `renderers/registry.ts` | Extend `CheckboxInfo` type to include `checkAll` alongside existing `uncheckAll` |
| `server.go` | Add `CheckAll` and `SetCheckboxBatch` State methods, handlers, route registration |

### New

| Component / Hook | Responsibility |
|------------------|---------------|
| `CheckboxActionsButton.tsx` | Dropdown in right action bar: Check All / Uncheck All |
| `SelectionActionBar.tsx` | Floating bar: "N of M selected — Check / Uncheck / Cancel" |
| `useCheckboxSelection.ts` | Selection state: anchor key, selected keys set, `selectRange(key)`, `clearSelection()`, `isSelected(key)`. Document-level click-outside and Escape listeners. |

### Deleted

| Component | Reason |
|-----------|--------|
| `UncheckAllButton.tsx` | Replaced by `CheckboxActionsButton.tsx` |

---

## Data Flow

### Clickable labels

1. User clicks `<li>` with `task-list-item` class.
2. `onClick` handler checks click target is not an `<a>` link.
3. Extracts `data-checkbox-key` from the child input element.
4. Calls `toggle(key)` from `useCheckboxState`.
5. Existing toggle flow: API PUT, SSE broadcast, state update.

### Shift-click range selection

1. User shift+clicks a checkbox or its label `<li>`.
2. `MarkdownRenderer` detects shift key, calls `onShiftClick(key)` (prop from `FileViewer`).
3. `useCheckboxSelection` in `FileViewer` handles anchor/range logic.
4. If anchor was already set, computes range using document order of `[data-checkbox-key]` elements via `articleRef`.
5. Selected keys stored in state; `isSelected(key)` passed to `MarkdownRenderer` drives `<li>` highlights.
6. `SelectionActionBar` conditionally renders in `FileViewer` when `selectedKeys.length >= 2`.
7. User clicks "Check" or "Uncheck" in the action bar.
8. `FileViewer` calls `batchSetCheckboxes(fileId, selectedKeys, checked)` — single API request.
9. Server applies changes atomically, broadcasts one `checkbox-changed` SSE event.
10. Clear selection.

### Check All

1. User clicks "Check All" in `CheckboxActionsButton` dropdown.
2. Calls `checkAllCheckboxes(fileId)` (new function in `useApi.ts`).
3. Server sets overrides via `State.CheckAll`, broadcasts `checkbox-changed` SSE event.
4. All clients update via existing SSE flow.

---

## Testing

### Go backend

- `TestCheckAllEndpoint` — sets all checkboxes to checked; source-true keys have no override, source-false keys get `override = true`.
- `TestCheckAllRemovesExistingOverrides` — previous override of `false` on a source-true key is cleared.
- `TestCheckAllReturns404` — unknown file ID returns 404.
- `TestBatchSetCheckboxes` — sets specific keys to checked/unchecked; verifies only those keys have overrides.
- `TestBatchSetIgnoresUnknownKeys` — keys not in checkboxSources are silently ignored.
- `TestBatchSetSingleSSEEvent` — verify only one `checkbox-changed` event is broadcast per batch call.

### Frontend (Vitest)

- `useCheckboxSelection.test.ts` — range computation produces correct keys in document order; clear resets; single shift-click sets anchor only (no range); escape clears; second shift-click after range resets to new anchor.
- `CheckboxActionsButton.test.ts` — renders dropdown; both actions fire correct callbacks.
- `SelectionActionBar.test.ts` — renders with "N of M" count; check/uncheck/cancel fire callbacks; not rendered when count < 2.
- `MarkdownRenderer` label click test — clicking `<li>` text toggles checkbox; clicking `<a>` inside label does not toggle.

### Manual verification

- Click label text toggles checkbox (not just the input).
- Links inside labels navigate instead of toggling.
- Shift+click first checkbox highlights it as anchor.
- Shift+click second checkbox highlights range, shows action bar.
- "Check" in action bar checks all selected, clears selection.
- Escape clears selection.
- Check All / Uncheck All dropdown works.
- Multi-client sync still works for all operations.
- Action bar is keyboard-accessible (Tab to buttons, Enter to activate).
