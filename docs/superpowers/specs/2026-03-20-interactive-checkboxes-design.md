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

- **filename**: Basename of the file (e.g., `"TODO.md"`). This means files with the same name in different directories intentionally share checkbox state. If this becomes problematic in practice, the key can be extended to include more path context in a future version.
- **checkboxKey**: Trimmed plain-text label of the checkbox, derived from the first paragraph of text content within the `<li>` (excluding nested lists, sub-paragraphs, etc.). Inline formatting (bold, italic, code, links) is stripped to produce plain text. For duplicate labels within the same file, the second and subsequent occurrences are disambiguated with `#N` suffixes: `"TODO"`, `"TODO#2"`, `"TODO#3"`. Empty checkbox labels use the key `"__empty"` (with the same `#N` disambiguation for duplicates).
- **boolean value**: The desired checked state (not a delta). `true` = checked, `false` = unchecked

### Reconciliation Rules

On file content change (initial load or SSE `file-changed` event):

1. The rehype plugin reports all checkbox keys and their source states via a callback (see Architecture)
2. For each stored override:
   - If the override value matches the source state → remove it (no longer a deviation)
   - If the checkbox key no longer exists in the file → remove it (checkbox was deleted)
   - Otherwise → keep it

### Known Limitation: Duplicate Label Reordering

The `#N` disambiguation scheme is position-dependent. If checkboxes with identical labels are reordered or new ones are inserted above existing ones, the suffix indices shift, potentially applying stored overrides to the wrong checkboxes. This is accepted for v1 — the reconciliation cleanup will eventually correct the state as the user interacts with the checkboxes.

## Architecture

### Rehype Plugin: `rehypeCheckboxKeys`

A custom rehype plugin positioned in the `rehypePlugins` array **after `rehypeRaw`** (which parses raw HTML into HAST nodes) and **before `rehypeSanitize`** (which would strip unknown attributes). Concrete insertion point:

```typescript
rehypePlugins={[
  rehypeRaw,
  [rehypeCheckboxKeys, { onCheckboxMap }],  // ← here
  [rehypeSanitize, sanitizeSchema],
  rehypeGithubAlerts,
  rehypeSlug,
  rehypeKatex,
]}
```

The plugin:

1. Walks the HAST to find `<input type="checkbox">` elements within list items
2. Extracts the plain-text label from the first paragraph of text content in the parent `<li>`, stripping inline formatting recursively
3. Tracks per-document occurrence counts to disambiguate duplicate labels
4. Adds a `data-checkbox-key` attribute to each checkbox `<input>`
5. Invokes the `onCheckboxMap` callback with a `Map<string, boolean>` of all checkbox keys → source checked states. This is how the hook receives the checkbox manifest without needing to re-parse the markdown independently.

The `rehype-sanitize` schema must be updated to allow `data-checkbox-key` on `input` elements:

```typescript
input: [...(defaultSchema.attributes?.["input"] || []), "data-checkbox-key"],
```

### Custom `input` Component

Registered via react-markdown's `components` prop on `MarkdownViewer`. For non-checkbox inputs, renders a standard `<input>`. For checkboxes:

1. Reads `data-checkbox-key` from props
2. Looks up the override state via the `useCheckboxOverrides` hook
3. Determines effective checked state: override if present, otherwise source state
4. Renders a clickable `<input type="checkbox">` — explicitly destructures and discards `disabled` from props to avoid passing it through via spread
5. On click, calls `toggle(key)` from the hook

Styling: `cursor: pointer` to indicate interactivity. Matches existing `github-markdown-css` checkbox appearance otherwise.

### Hook: `useCheckboxOverrides(filename)`

Centralizes localStorage persistence and reconciliation logic. Returns:

- `getChecked(key: string): boolean` — returns override value if present, otherwise source state from the checkbox map
- `toggle(key: string): void` — flips the effective state. If the new value matches source state, removes the override instead of storing it
- `setCheckboxMap(map: Map<string, boolean>): void` — called by the rehype plugin's `onCheckboxMap` callback to provide the current checkbox manifest. Triggers reconciliation.

**Internal behavior:**

- When `setCheckboxMap` is called (on each render pass where the plugin runs): stores the map, runs reconciliation against stored overrides, updates localStorage
- Reads/writes localStorage following the existing codebase pattern: `try/catch` around `JSON.parse` with `{}` fallback
- Content change is triggered automatically by the existing SSE `file-changed` → re-fetch flow in `MarkdownViewer`, which causes a re-render, which re-runs the plugin, which calls `setCheckboxMap`

Note: The `extractText` utility at `internal/frontend/src/utils/extractText.ts` provides a reference implementation for recursive text extraction from React nodes. The rehype plugin operates on HAST nodes (not React nodes) but follows the same pattern.

### Pipeline Data Flow

```
Markdown source
  → remark-gfm (creates checkbox <input> elements)
  → rehypeRaw (parses raw HTML into HAST)
  → rehypeCheckboxKeys (annotates inputs with data-checkbox-key, reports map via callback)
  → rehypeSanitize (preserves data-checkbox-key via schema allowlist)
  → react-markdown renders custom <input> component
  → component reads data-checkbox-key, consults useCheckboxOverrides hook
  → user clicks → toggle() → localStorage updated → re-render
```

## Edge Cases

### Duplicate checkbox labels

Handled via `#N` suffix disambiguation. The rehype plugin tracks occurrence counts per label and appends the suffix starting from the second occurrence (`#2`, `#3`, etc.).

### Checkbox labels with inline formatting

Labels like `- [ ] **bold** item` produce child nodes in the HAST. The plugin extracts plain text recursively from child nodes in the first paragraph, yielding `"bold item"` as the key.

### Empty checkbox labels

`- [ ] ` (no text) uses the key `"__empty"`, with `#N` disambiguation for multiples.

### Duplicate filenames across directories

By design, files with the same basename share checkbox state. This is the intended behavior — state follows the filename, not the full path. The file ID (SHA-256 of absolute path) is available as an alternative key if this needs to change in the future.

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
- `internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts` — plugin tests
- `internal/frontend/src/hooks/useCheckboxOverrides.test.ts` — hook tests

### Key test scenarios
- Basic toggle: check unchecked, uncheck checked
- Duplicate labels: correct `#N` disambiguation
- Inline formatting: stripped to plain text for key
- Reconciliation: overrides cleaned up when source changes to match
- Reconciliation: overrides removed when checkbox deleted from source
- Empty labels: `__empty` keying
- Multiple files: independent override state per filename

### Modified files
- `internal/frontend/src/components/MarkdownViewer.tsx` — add plugin to pipeline, register custom `input` component, update sanitize schema
- Sanitize schema: add `data-checkbox-key` to allowed `input` attributes

### No server-side changes
