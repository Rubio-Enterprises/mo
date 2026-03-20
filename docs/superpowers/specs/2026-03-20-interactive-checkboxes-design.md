# Interactive Checkboxes in mo

## Overview

Add interactive checkbox support to mo's markdown viewer. Users can check/uncheck task list items (`- [ ]` / `- [x]`) in the browser without modifying the source markdown file. Checkbox state is persisted in browser localStorage as an overlay on top of the source state.

## Requirements

- Checkboxes rendered from GFM task lists become clickable in the browser
- Checking/unchecking does NOT modify the source markdown file
- State persists across browser sessions (localStorage)
- State is keyed by filename (basename), so the same file opened from different directories shares state
- State tracks deviations from source — source-checked boxes appear checked without an override
- When the source file changes, overrides are reconciled: stale or matching overrides are cleaned up
- No server-side changes required for v1

## Non-Goals (v1)

- Visual indicator for overridden checkboxes (future enhancement)
- Write-back to source file (future enhancement, but design should not preclude it)
- Cross-browser sync
- Server-side state storage

## Data Model

### localStorage Key

`mo-checkbox-overrides`

### Structure

```typescript
type CheckboxOverrides = {
  [filename: string]: {
    [checkboxKey: string]: boolean
  }
}
```

- **filename**: Basename of the file (e.g., `"TODO.md"`)
- **checkboxKey**: Trimmed plain-text label of the checkbox. For duplicate labels within the same file, the second and subsequent occurrences are disambiguated with a `#N` suffix (1-indexed): `"TODO"`, `"TODO#1"`, `"TODO#2"`
- **boolean value**: The desired checked state (not a delta). `true` = checked, `false` = unchecked

### Reconciliation Rules

On file content change (initial load or SSE `file-changed` event):

1. Parse all checkbox keys and their source states from the markdown
2. For each stored override:
   - If the override value matches the source state → remove it (no longer a deviation)
   - If the checkbox key no longer exists in the file → remove it (checkbox was deleted)
   - Otherwise → keep it

## Architecture

### Rehype Plugin: `rehypeCheckboxKeys`

A custom rehype plugin that runs after `remark-gfm` in the markdown pipeline. It:

1. Walks the HAST (HTML AST) to find `<input type="checkbox">` elements within list items
2. Extracts the plain-text label from sibling/child nodes in the same `<li>`, stripping inline formatting (bold, italic, code, links, etc.)
3. Tracks per-file occurrence counts to disambiguate duplicate labels
4. Adds a `data-checkbox-key` attribute to each checkbox `<input>`

The `rehype-sanitize` schema must be updated to allow `data-checkbox-key` on `input` elements. The codebase already customizes the sanitize schema, so this follows the existing pattern.

### Custom `input` Component

Registered via react-markdown's `components` prop on `MarkdownViewer`. For non-checkbox inputs, renders a standard `<input>`. For checkboxes:

1. Reads `data-checkbox-key` from props
2. Looks up the override state via the `useCheckboxOverrides` hook
3. Determines effective checked state: override if present, otherwise source state
4. Renders a clickable `<input type="checkbox">` (removes the `disabled` attribute that remark-gfm adds)
5. On click, calls `toggle(key)` from the hook

Styling: `cursor: pointer` to indicate interactivity. Matches existing `github-markdown-css` checkbox appearance otherwise.

### Hook: `useCheckboxOverrides(filename, content)`

Centralizes localStorage persistence and reconciliation logic. Returns:

- `getChecked(key: string): boolean` — returns override value if present, otherwise source state
- `toggle(key: string): void` — flips the effective state. If the new value matches source state, removes the override instead of storing it

**Internal behavior:**

- On mount and when `content` changes: parses markdown to extract checkbox keys and source states, runs reconciliation, updates localStorage
- Reads/writes localStorage following the existing codebase pattern: `try/catch` around `JSON.parse` with `{}` fallback
- Content change is triggered automatically by the existing SSE `file-changed` → re-fetch flow in `MarkdownViewer`

### Pipeline Position

The rehype plugin is inserted into the react-markdown plugin chain after `remark-gfm` (which creates the checkbox elements) and before `rehype-sanitize` (which would strip unknown attributes). The sanitize schema is updated to preserve `data-checkbox-key`.

## Edge Cases

### Duplicate checkbox labels

Handled via `#N` suffix disambiguation. The rehype plugin tracks occurrence counts per label and appends the suffix starting from the second occurrence.

### Checkbox labels with inline formatting

Labels like `- [ ] **bold** item` produce child nodes in the HAST. The plugin extracts plain text recursively from all child nodes, yielding `"bold item"` as the key.

### Duplicate filenames across directories

By design, files with the same basename share checkbox state. This is the intended behavior — the user wants state to follow the filename, not the full path.

### Raw view toggle

No interactivity in raw view. The custom `input` component only applies in the rendered markdown view, which is already the behavior since raw view shows source text.

### Large files

localStorage handles hundreds of checkbox keys easily. Reconciliation is O(n) where n is the number of checkboxes in the file.

### Multiple files open simultaneously

Each file has its own entry in the overrides map, keyed by filename. No conflict between files.

## Files to Create/Modify

### New files
- `internal/frontend/src/plugins/rehypeCheckboxKeys.ts` — rehype plugin
- `internal/frontend/src/hooks/useCheckboxOverrides.ts` — persistence hook
- Tests for both

### Modified files
- `internal/frontend/src/components/MarkdownViewer.tsx` — add plugin to pipeline, register custom `input` component
- Sanitize schema configuration (in `MarkdownViewer.tsx`) — allow `data-checkbox-key` on `input`

### No server-side changes
