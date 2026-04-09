# Server-Side Checkbox State

## Summary

Move checkbox override state from client-side localStorage to the Go server. This enables multi-client sync (all browsers see the same checkbox state) and integrates checkbox state into the backup/restore lifecycle.

## Motivation

- **Multi-client sync:** Multiple browsers viewing the same mo instance should see identical checkbox state.
- **Backup/restore integration:** Checkbox state should survive browser cache clears and be part of the server session lifecycle.

## Data Model

### Server State

Add to the `State` struct:

```go
checkboxSources   map[string]map[string]bool // fileID -> checkboxKey -> source checked state (from markdown)
checkboxOverrides map[string]map[string]bool // fileID -> checkboxKey -> overridden checked state
```

Both initialized as empty maps in `NewState()`. Protected by the existing `s.mu` mutex.

`checkboxSources` is populated by the extraction function when a file is added or its content changes. It represents what the markdown says. `checkboxOverrides` stores only user-toggled values that differ from the source.

### Backup Persistence

Add to `RestoreData`:

```go
CheckboxOverrides map[string]map[string]bool `json:"checkboxOverrides,omitempty"`
```

Only overrides are persisted. `checkboxSources` is reconstructed from file content on restore (files are re-read during `AddFile`).

Included in `snapshotRestoreData()` and restored on startup via `backup.Load()`. The `omitempty` tag keeps the backup file clean when no overrides exist.

### Cleanup on File Removal

When `RemoveFile()` is called, delete the file's entry from both `checkboxSources` and `checkboxOverrides`.

### Population on File Add

Both `AddFile()` and `AddUploadedFile()` must call the checkbox extraction function after adding the file. `AddFile` reads content from disk (reusing the `head` bytes already read for title extraction). `AddUploadedFile` reads from the `content` parameter. The extracted source map is stored in `checkboxSources[fileID]`.

## API Endpoints

### `GET /_/api/files/{id}/checkboxes`

Returns overrides for a file.

Response:
```json
{
  "sources": {"Task A": false, "Task B": true, "Task C": false},
  "overrides": {"Task B": false}
}
```

`sources` contains the checkbox state as written in the markdown. `overrides` contains only user-toggled values that differ from the source. The frontend computes effective checked state: `overrides[key] ?? sources[key]`.

Returns empty objects if no checkboxes or overrides exist. Returns 404 if the file ID doesn't exist.

### `PUT /_/api/files/{id}/checkboxes/{key}`

Toggle a single checkbox. The `{key}` is URL-encoded.

Request body: `{"checked": true}`

Reconciliation: if the new value matches the source value (from the markdown), the override is removed rather than stored.

The handler must call `s.markDirty()` directly after updating state (before or after `sendEvent`), since `sendEvent` only calls `markDirty` for `eventUpdate` events. This applies to all three checkbox endpoints.

The `{key}` path parameter is URL-encoded by the client. Go 1.22+ `ServeMux` does not automatically decode `{wildcard}` path values, so the handler must call `url.PathUnescape(r.PathValue("key"))` to decode it.

Triggers `checkbox-changed` SSE event. Returns 404 if the file ID doesn't exist.

### `DELETE /_/api/files/{id}/checkboxes`

Uncheck-all operation. Replaces all overrides for the file with a new set: for every key in `checkboxSources` where the source value is `true`, set an override of `false`. Additionally, remove any existing overrides for source-false keys (clearing any user-toggled `true` overrides). The net effect is that all checkboxes become unchecked.

Triggers SSE event. Returns 404 if file ID doesn't exist.

## SSE Event

New event type: `checkbox-changed`

Payload:
```json
{"fileId": "a1b2c3d4", "sources": {"Task A": false, "Task B": true}, "overrides": {"Task B": false}}
```

Contains the full sources and overrides maps for the file (not a diff). Clients replace their local state for that file entirely on receipt.

Fires on:
- Toggle (PUT)
- Uncheck all (DELETE)
- Server-side reconciliation after file content changes

Clients treat the server as source of truth. After sending a PUT/DELETE, the client waits for the SSE event to update the UI rather than optimistically updating. Localhost latency makes this imperceptible.

## Server-Side Checkbox Key Extraction

The TypeScript `rehypeCheckboxKeys` plugin operates on the parsed HAST tree (after remark/rehype processing), where inline formatting (`**bold**`, `*italic*`, `` `code` ``, `[links](url)`) has already been stripped down to text nodes. A naive regex over raw markdown cannot replicate this — keys like `"bold and italic text"` from `**bold** and *italic* text` would be wrong.

**Approach:** Use `goldmark` (Go markdown parser with GFM extension) to parse the markdown into an AST, then walk `ast.ListItem` nodes that have `TaskCheckBox` children. Extract label text by recursively collecting text content from child nodes (excluding nested lists), mirroring the HAST traversal in `extractHastText`.

Add `github.com/yuin/goldmark` and `github.com/yuin/goldmark/extension` as Go dependencies.

Key computation matches the TypeScript `computeCheckboxKey` algorithm:
- Trim label text
- Use `"__empty"` for blank labels
- Append `#2`, `#3`, etc. for duplicate labels

Go tests must verify parity with the existing TypeScript test cases:
- `"- [ ] First item"` → key `"First item"`, unchecked
- `"- [x] Second item"` → key `"Second item"`, checked
- Duplicate labels: `"TODO"`, `"TODO#2"`, `"TODO#3"`
- Inline formatting stripped: `"- [ ] **bold** and *italic* text"` → key `"bold and italic text"`
- Code spans and links stripped: `` "- [ ] Use `fetch` to call [the API](url)" `` → key `"Use fetch to call the API"`
- Empty labels: `"__empty"`, `"__empty#2"`

## Reconciliation

Runs inside the existing file-changed watch handler. On file modification:

1. Read file content
2. Extract checkbox keys and source states
3. Compare against stored overrides
4. Remove overrides where the key no longer exists
5. Remove overrides where the stored value now matches the source
6. If overrides changed, broadcast `checkbox-changed` SSE event and mark dirty for backup

## Frontend Changes

### Remove

- `useCheckboxOverrides.ts` hook (entirely replaced by server state)
- `localStorage` key `mo-checkbox-overrides` (no longer used)

### Modified: `useSSE.ts`

Add an `onCheckboxChanged` optional callback to `SSECallbacks`:

```typescript
interface SSECallbacks {
  onUpdate: () => void;
  onFileChanged?: (fileId: string) => void;
  onCheckboxChanged?: (fileId: string, sources: Record<string, boolean>, overrides: Record<string, boolean>) => void;
}
```

Add a new `addEventListener("checkbox-changed", ...)` block that parses the event data and calls `callbacksRef.current.onCheckboxChanged?.(data.fileId, data.sources, data.overrides)`. This reuses the single shared `EventSource` connection and its reconnect/pid-change logic.

### New: `useCheckboxState.ts`

- Fetches initial state from `GET /_/api/files/{id}/checkboxes` on mount / file ID change
- During the initial fetch, `hasCheckboxes` defaults to `false`. This is acceptable because the rehype plugin also reports `hasCheckboxes` independently (see below), so the uncheck-all button visibility is not solely dependent on the fetch completing.
- Receives `checkbox-changed` SSE events via the `onCheckboxChanged` callback wired through `useSSE`. Filters by file ID and replaces local `sources` and `overrides` state on match.
- Exposes `getChecked(key)`, `toggle(key)`, `uncheckAll()`, `hasCheckboxes` (same interface as before)
- `getChecked` computes `overrides[key] ?? sources[key]`
- `toggle` calls `PUT /_/api/files/{id}/checkboxes/{encodeURIComponent(key)}`
- `uncheckAll` calls `DELETE /_/api/files/{id}/checkboxes`

### Retained: `rehypeCheckboxKeys.ts`

Still runs client-side to assign `data-checkbox-key` attributes for rendering and to report `hasCheckboxes` for the uncheck-all button visibility. No longer drives state.

### Modified: `MarkdownRenderer.tsx`

- Swap `useCheckboxOverrides(basename)` for `useCheckboxState(fileId)`
- `onCheckboxMap` callback still used for `hasCheckboxes` reporting, no longer manages state

### No migration

Existing localStorage overrides are ignored. Clean break; checkbox toggles are transient by nature.

## Edge Cases

- **Non-markdown files (PDF, image, binary, code):** Checkbox extraction only runs for markdown file types. `GET /_/api/files/{id}/checkboxes` returns `{"sources": {}, "overrides": {}}` for non-markdown files (not 404, since the file exists). PUT and DELETE on non-markdown files return 404 since there are no source keys to operate on.
- **Uploaded files:** Checkbox extraction reads from `FileEntry.content` instead of disk. No reconciliation on file change (uploaded files don't change on disk).
- **Server restart (`--restart`):** Overrides are in `RestoreData`, so they survive. The `restart` SSE event triggers `window.location.reload()` in `useSSE.ts`, which causes the new `useCheckboxState` hook to reinitialize and re-fetch from the server. Sources are reconstructed from file content during `AddFile` on restart.
- **`--clear` flag:** Clears backup, wiping overrides along with everything else.
- **Concurrent toggles (different keys):** Both acquire the mutex sequentially, both succeed, both clients get SSE events with the full updated map.
- **Concurrent toggles (same key):** Last write wins. Both clients receive the final SSE event reflecting the settled state.
- **File removed:** Both `checkboxSources` and `checkboxOverrides` entries deleted from map. No SSE event needed — clients navigating away from a removed file won't be listening.

## Scoping Note

Per file ID scoping (SHA-256 based). Two files with the same basename but different paths have independent checkbox state.
