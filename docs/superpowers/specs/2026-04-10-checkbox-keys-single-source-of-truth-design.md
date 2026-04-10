# Checkbox Keys: Single Source of Truth

## Problem

Checkbox state is persisted by content-derived keys (e.g. `"Buy milk"`, `"TODO#2"`). The key for each checkbox is computed twice: once in Go (`internal/server/checkbox.go`) using goldmark's AST, and once in TypeScript (`internal/frontend/src/plugins/rehypeCheckboxKeys.ts`) using rehype's HAST. Both extractors must produce byte-identical keys for the same markdown, or overrides are silently lost during `RestoreCheckboxOverrides` (the backend prunes any override whose key is not found in `checkboxSources`).

Two recent drift bugs confirmed this is fragile:

1. goldmark dropped `SoftLineBreak` / `HardLineBreak` markers while rehype preserved them as `\n`.
2. goldmark recursed into every paragraph of a loose list item while rehype only used the first `<p>`.

Both were fixed by patching the Go extractor, but the underlying design — two independent extractors that must agree — will continue to produce these bugs whenever either parser's representation changes.

## Goal

Eliminate dual key computation. The backend becomes the sole authority for checkbox keys; the frontend receives the keys as data and never parses text to compute them.

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

Populate it everywhere `checkboxSources` is populated (`AddFile`, `notifyFileChangedByPath`, `AddUploadedFile` if applicable). Keep the old name `ExtractCheckboxSources` as a thin wrapper if any callers outside the server package use it; otherwise delete it.

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

```typescript
interface RehypeCheckboxIndicesOptions {
  orderedKeys: string[];
}

export function rehypeCheckboxIndices({ orderedKeys }: RehypeCheckboxIndicesOptions) {
  return (tree: Root) => {
    let index = 0;
    visit(tree, "element", (node: HastElement) => {
      if (node.tagName !== "input" || node.properties?.type !== "checkbox") {
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

`MarkdownRenderer.tsx` reads `orderedKeys` from `useCheckboxState` and passes it into the rehype plugin as an option:

```typescript
rehypePlugins={[
  rehypeRaw,
  [rehypeCheckboxIndices, { orderedKeys }],
  // ...
]}
```

Because `orderedKeys` is now a render-time input to the plugin, it must be included in the `renderedContent` useMemo dependency array so that the rendered tree updates when keys arrive from the async fetch.

### Safety: count mismatch behavior

If goldmark and remark-gfm ever disagree on checkbox count (e.g. 5 vs 6 for the same document), the plugin assigns keys up to `orderedKeys.length` and leaves additional checkboxes without a `data-checkbox-key`. The existing `input` component already handles this case — unkeyed checkboxes render disabled (`MarkdownRenderer.tsx:569-572`). This is a visible, debuggable failure mode rather than a silent key mismatch.

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
  - Preserves existing `data-*` attributes on inputs

## Files Touched

- `internal/server/checkbox.go` — rename `ExtractCheckboxSources`, return ordered keys
- `internal/server/checkbox_test.go` — adapt tests
- `internal/server/server.go` — new `checkboxOrderedKeys` field, updated `GetCheckboxState`, updated `handleGetCheckboxes`, updated `broadcastCheckboxChanged` and its caller, updated `AddFile` / `notifyFileChangedByPath` to populate ordered keys, updated `RestoreCheckboxOverrides` signature if needed
- `internal/server/server_test.go` — adapt checkbox-related tests
- `internal/frontend/src/plugins/rehypeCheckboxKeys.ts` — rewrite as index-assigning plugin (or rename to `rehypeCheckboxIndices.ts`)
- `internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts` — rewrite tests
- `internal/frontend/src/hooks/useApi.ts` — add `orderedKeys` to `CheckboxState` type
- `internal/frontend/src/hooks/useCheckboxState.ts` — store ordered keys, return them
- `internal/frontend/src/renderers/MarkdownRenderer.tsx` — pass `orderedKeys` to plugin, add to `renderedContent` dependencies
- `internal/frontend/src/App.tsx` — update SSE handler if payload shape changes
