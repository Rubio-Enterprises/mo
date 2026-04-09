# Bulk Checkbox Operations Design

**Goal:** Add clickable checkbox labels, shift-click range selection with bulk check/uncheck, and a "Check All" operation to complement the existing "Uncheck All."

**Scope:** Single-file checkbox operations only. Multi-file bulk operations are out of scope.

---

## Feature 1: Clickable Checkbox Labels

The `<li>` element containing a task checkbox becomes a click target. Clicking anywhere on the list item text (not just the `<input>`) toggles the checkbox.

### Implementation

In `MarkdownRenderer.tsx`, add a component override for `li` that:

1. Detects if the list item contains a checkbox by checking for a child `<input>` with a `data-checkbox-key` attribute.
2. Attaches an `onClick` handler to the `<li>` that calls `toggle(key)`.
3. Prevents double-toggle: the `<input>` keeps its existing `onChange`, but `onClick` on the `<li>` calls `e.preventDefault()` when the target is the input itself (or uses `stopPropagation` on the input's handler).

### Visual Feedback

- `cursor: pointer` on task list items.
- Subtle hover highlight (`bg-gh-bg-hover` with rounded corners) on the `<li>`.

### Edge Cases

- **Links inside labels:** Clicking an `<a>` tag should navigate, not toggle. The `onClick` handler checks if `e.target` (or any ancestor up to the `<li>`) is an `<a>` — if so, bail out.
- **Code spans and inline elements:** These toggle when clicked (they are part of the label).

---

## Feature 2: Shift-Click Range Selection

Shift+clicking a checkbox or its label text selects a range of checkboxes. A floating action bar appears for bulk operations.

### Selection Mechanics

| Interaction | Behavior |
|-------------|----------|
| Normal click (no modifier) | Toggle that single checkbox immediately |
| Shift+click | First shift+click sets the anchor. Second shift+click selects everything between anchor and target (inclusive) |
| Shift+click again (after a range exists) | Resets, starts new range from new anchor |
| Escape | Clears selection |
| Click outside checkboxes | Clears selection |
| Ctrl/Cmd+click | Out of scope for initial implementation |

### Visual Treatment

- Selected `<li>` elements get a background highlight (e.g., `bg-blue-50 dark:bg-blue-900/20`) and a left border accent.
- The checkbox `<input>` itself is not visually changed — the highlight is on the `<li>`.

### Floating Action Bar (`SelectionActionBar`)

- Appears anchored at the bottom of the content area when 2+ checkboxes are selected.
- Content: **"N selected"** — **Check** | **Uncheck** | **Cancel**
- Styled to match GitHub theme (border, subtle shadow, rounded).
- "Cancel" clears selection and dismisses the bar.
- "Check" / "Uncheck" fires individual `PUT /_/api/files/{id}/checkboxes/{key}` calls for each selected checkbox that needs to change state, then clears selection.

### State Management

- Selection state is local (React `useState`) — transient UI, not persisted or synced.
- Range calculation uses document order of `[data-checkbox-key]` elements in the DOM.

---

## Feature 3: Check All Endpoint

New server endpoint to set all checkboxes to checked, complementing the existing "Uncheck All" (`DELETE /_/api/files/{id}/checkboxes`).

### API

`POST /_/api/files/{id}/checkboxes/check-all`

- Returns `204 No Content` on success.
- Returns `404 Not Found` if the file ID is unknown.
- Broadcasts a `checkbox-changed` SSE event.

### Server Logic (`State.CheckAll`)

For each checkbox key in `checkboxSources[id]`:
- If source is `true`: remove any override (already checked).
- If source is `false`: set `override = true`.

Same pattern as `UncheckAll` but inverted.

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
| `MarkdownRenderer.tsx` | `li` override for clickable labels; shift-click detection on both `li` and `input`; selection highlighting; renders `SelectionActionBar` |
| `FileViewer.tsx` | Swap `UncheckAllButton` for `CheckboxActionsButton`; pass `onCheckAll` alongside `onUncheckAll` via `onCheckboxInfo` |
| `useCheckboxState.ts` | Add `checkAll()` function; include it in `onCheckboxInfo` data |
| `useApi.ts` | Add `checkAllCheckboxes(id: string)` function |
| `server.go` | Add `CheckAll` State method, `handleCheckAll` handler, route registration |

### New

| Component / Hook | Responsibility |
|------------------|---------------|
| `CheckboxActionsButton.tsx` | Dropdown in right action bar: Check All / Uncheck All |
| `SelectionActionBar.tsx` | Floating bar: "N selected — Check / Uncheck / Cancel" |
| `useCheckboxSelection.ts` | Selection state: anchor key, selected keys set, `selectRange(key)`, `clearSelection()`, `isSelected(key)`. Escape listener. |

### Deleted

| Component | Reason |
|-----------|--------|
| `UncheckAllButton.tsx` | Replaced by `CheckboxActionsButton.tsx` |

---

## Data Flow

### Clickable labels

1. User clicks `<li>` containing a checkbox.
2. `onClick` handler extracts `data-checkbox-key` from child input.
3. Calls `toggle(key)` from `useCheckboxState`.
4. Existing toggle flow: API PUT, SSE broadcast, state update.

### Shift-click range selection

1. User shift+clicks a checkbox or label.
2. `MarkdownRenderer` detects shift key, calls `useCheckboxSelection.selectRange(key)`.
3. Hook computes range using document order of `[data-checkbox-key]` elements.
4. Selected keys stored in state; `isSelected(key)` drives `<li>` highlight.
5. `SelectionActionBar` renders when `selectedKeys.length >= 2`.
6. User clicks "Check" or "Uncheck" in the action bar.
7. Loop through selected keys, call `toggle(key)` for each that needs to change.
8. Clear selection.

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

### Frontend (Vitest)

- `useCheckboxSelection.test.ts` — range computation produces correct keys in document order; clear resets; single shift-click sets anchor only; escape clears.
- `CheckboxActionsButton.test.ts` — renders dropdown; both actions fire correct callbacks.
- `SelectionActionBar.test.ts` — renders with count; check/uncheck/cancel fire callbacks; hidden when count < 2.

### Manual verification

- Click label text toggles checkbox (not just the input).
- Links inside labels navigate instead of toggling.
- Shift+click two checkboxes highlights the range, shows action bar.
- "Check" in action bar checks all selected, clears selection.
- Escape clears selection.
- Check All / Uncheck All dropdown works.
- Multi-client sync still works for all operations.
