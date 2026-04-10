# Checkbox Keys: Single Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate text-extraction drift between the Go and TypeScript checkbox-key extractors by making the backend the sole authority: it returns an ordered slice of keys, and the frontend plugin assigns them positionally to checkboxes inside `<li class="task-list-item">`.

**Architecture:** `ExtractCheckboxSources` is replaced with `ExtractCheckboxes(content) (map, []string)`. State tracks `checkboxOrderedKeys[fileID] []string` alongside sources/overrides. The `GET /_/api/files/{id}/checkboxes` response and the `checkbox-changed` SSE payload both gain an `orderedKeys` field. On the frontend, `useCheckboxState` stores `orderedKeys` plus a `checkboxesLoaded` flag, the rehype plugin (`rehypeCheckboxIndices`) is dumbed down to index-assignment scoped to GFM task-list items, and `MarkdownRenderer` gates rendering on `checkboxesLoaded` to avoid first-paint flicker.

**Tech Stack:** Go 1.26+, goldmark (GFM), React 19, TypeScript, unified/rehype, Vitest

---

## File Structure

### Go (backend)

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `internal/server/checkbox.go` | Delete `ExtractCheckboxSources`, add `ExtractCheckboxes` returning `(map[string]bool, []string)` |
| Modify | `internal/server/checkbox_test.go` | Rename `TestExtractCheckboxSources` → `TestExtractCheckboxes`; assert both map and ordered slice; add blockquote/table cross-parser ordering cases |
| Modify | `internal/server/server.go` | New `checkboxOrderedKeys map[string][]string` state field; updated `GetCheckboxState` signature; updated `handleGetCheckboxes` response; updated `broadcastCheckboxChanged` signature; populate `checkboxOrderedKeys` in `AddFile`/`AddUploadedFile`/`notifyFileChangedByPath`; delete from `RemoveFile` |
| Modify | `internal/server/server_test.go` | `newTestState` initializes `checkboxOrderedKeys`; checkbox-related tests assert the new field where relevant |

### TypeScript (frontend)

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `internal/frontend/src/hooks/useApi.ts` | `CheckboxState` gains `orderedKeys: string[]` |
| Modify | `internal/frontend/src/hooks/useSSE.ts` | `onCheckboxChanged` callback signature gains `orderedKeys: string[]` |
| Modify | `internal/frontend/src/App.tsx` | Forward `orderedKeys` into `mo-checkbox-changed` custom event detail |
| Modify | `internal/frontend/src/hooks/useCheckboxState.ts` | Store `orderedKeys`, return it from the hook; add `checkboxesLoaded: boolean` flag that flips after first fetch resolves/rejects; reset on `fileId` change |
| Rename | `internal/frontend/src/plugins/rehypeCheckboxKeys.ts` → `rehypeCheckboxIndices.ts` | Replace text-extraction/key-computation with index-assignment scoped to `<li class="task-list-item">` checkboxes |
| Rename | `internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts` → `rehypeCheckboxIndices.test.ts` | Drop extraction/key-compute cases; add index-assignment, count-mismatch, raw-HTML-checkbox-skipping cases |
| Modify | `internal/frontend/src/renderers/MarkdownRenderer.tsx` | Import new plugin; pass `orderedKeys` as plugin option; include `orderedKeys` in `renderedContent` deps alongside existing `checkboxRevision`; gate rendering on `checkboxesLoaded` |

---

## Execution Order Rationale

Backend changes ship first because the new `orderedKeys` field is additive on the wire — the existing frontend simply ignores it, so the backend can land independently without breaking anything. Frontend changes then land in dependency order: types → hooks → plugin + renderer together (the plugin rewrite and its caller must be atomic because the plugin's public contract changes).

---

### Task 1: Backend — `ExtractCheckboxes` returns ordered keys

**Files:**
- Modify: `internal/server/checkbox.go`
- Modify: `internal/server/checkbox_test.go`

- [ ] **Step 1: Write the failing test for `ExtractCheckboxes`**

Add this test at the top of `internal/server/checkbox_test.go`, replacing the existing `TestExtractCheckboxSources` function (keep `TestComputeCheckboxKey` above it unchanged):

```go
func TestExtractCheckboxes(t *testing.T) {
	t.Run("basic items return map and ordered keys", func(t *testing.T) {
		md := "- [ ] First item\n- [x] Second item\n"
		sources, ordered := ExtractCheckboxes(md)
		if len(sources) != 2 {
			t.Fatalf("got %d sources, want 2", len(sources))
		}
		if sources["First item"] != false {
			t.Fatal("First item should be false")
		}
		if sources["Second item"] != true {
			t.Fatal("Second item should be true")
		}
		if len(ordered) != 2 {
			t.Fatalf("got %d ordered keys, want 2", len(ordered))
		}
		if ordered[0] != "First item" || ordered[1] != "Second item" {
			t.Fatalf("ordered keys out of order: %v", ordered)
		}
	})

	t.Run("duplicate labels are disambiguated in order", func(t *testing.T) {
		md := "- [ ] TODO\n- [ ] TODO\n- [x] TODO\n"
		sources, ordered := ExtractCheckboxes(md)
		if len(sources) != 3 {
			t.Fatalf("got %d sources, want 3", len(sources))
		}
		want := []string{"TODO", "TODO#2", "TODO#3"}
		if len(ordered) != 3 {
			t.Fatalf("got %d ordered keys, want 3", len(ordered))
		}
		for i, k := range want {
			if ordered[i] != k {
				t.Fatalf("ordered[%d] = %q, want %q", i, ordered[i], k)
			}
		}
		if sources["TODO#3"] != true {
			t.Fatal("TODO#3 should be true")
		}
	})

	t.Run("strips inline formatting", func(t *testing.T) {
		md := "- [ ] **bold** and *italic* text\n"
		sources, ordered := ExtractCheckboxes(md)
		if _, ok := sources["bold and italic text"]; !ok {
			t.Fatalf("expected key 'bold and italic text', got: %v", sources)
		}
		if len(ordered) != 1 || ordered[0] != "bold and italic text" {
			t.Fatalf("ordered = %v", ordered)
		}
	})

	t.Run("strips code spans and links", func(t *testing.T) {
		md := "- [ ] Use `fetch` to call [the API](https://example.com)\n"
		sources, ordered := ExtractCheckboxes(md)
		if _, ok := sources["Use fetch to call the API"]; !ok {
			t.Fatalf("expected key 'Use fetch to call the API', got: %v", sources)
		}
		if len(ordered) != 1 || ordered[0] != "Use fetch to call the API" {
			t.Fatalf("ordered = %v", ordered)
		}
	})

	t.Run("empty markdown returns empty map and slice", func(t *testing.T) {
		sources, ordered := ExtractCheckboxes("")
		if len(sources) != 0 {
			t.Fatalf("got %d sources, want 0", len(sources))
		}
		if len(ordered) != 0 {
			t.Fatalf("got %d ordered keys, want 0", len(ordered))
		}
	})

	t.Run("no checkboxes returns empty map and slice", func(t *testing.T) {
		md := "# Hello\n\n- Regular list\n- Another item\n"
		sources, ordered := ExtractCheckboxes(md)
		if len(sources) != 0 {
			t.Fatalf("got %d sources, want 0", len(sources))
		}
		if len(ordered) != 0 {
			t.Fatalf("got %d ordered keys, want 0", len(ordered))
		}
	})

	t.Run("uppercase X is checked", func(t *testing.T) {
		md := "- [X] Done\n"
		sources, _ := ExtractCheckboxes(md)
		if sources["Done"] != true {
			t.Fatal("uppercase X should be checked")
		}
	})

	t.Run("nested list excluded from label", func(t *testing.T) {
		md := "- [ ] Parent\n  - [ ] Child\n"
		sources, ordered := ExtractCheckboxes(md)
		if _, ok := sources["Parent"]; !ok {
			t.Fatal("missing key Parent")
		}
		if _, ok := sources["Child"]; !ok {
			t.Fatal("missing key Child")
		}
		// Document order: Parent before Child.
		if len(ordered) != 2 || ordered[0] != "Parent" || ordered[1] != "Child" {
			t.Fatalf("ordered = %v", ordered)
		}
	})

	t.Run("soft line break preserved in key", func(t *testing.T) {
		md := "- [ ] First line\n  continued text\n"
		sources, _ := ExtractCheckboxes(md)
		want := "First line\ncontinued text"
		if _, ok := sources[want]; !ok {
			t.Fatalf("expected key %q, got: %v", want, sources)
		}
	})

	t.Run("loose list uses only first paragraph", func(t *testing.T) {
		md := "- [ ] Task A\n\n  More details\n\n- [ ] Task B\n"
		sources, ordered := ExtractCheckboxes(md)
		if _, ok := sources["Task A"]; !ok {
			t.Fatalf("expected key 'Task A', got: %v", sources)
		}
		if _, ok := sources["Task B"]; !ok {
			t.Fatalf("expected key 'Task B', got: %v", sources)
		}
		if len(ordered) != 2 || ordered[0] != "Task A" || ordered[1] != "Task B" {
			t.Fatalf("ordered = %v", ordered)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails (function does not exist yet)**

Run: `cd /vm-mo && go test ./internal/server/ -run TestExtractCheckboxes -v`
Expected: FAIL with `undefined: ExtractCheckboxes`.

- [ ] **Step 3: Replace `ExtractCheckboxSources` with `ExtractCheckboxes`**

In `internal/server/checkbox.go`, replace the existing `ExtractCheckboxSources` function (lines 84-138) with:

```go
// ExtractCheckboxes parses markdown content and returns a map of checkbox key
// to source checked state alongside an ordered slice of keys in document order.
// Keys are computed using the same algorithm as the frontend (content-derived,
// with `#N` disambiguation for duplicates).
func ExtractCheckboxes(content string) (map[string]bool, []string) {
	source := []byte(content)
	md := goldmark.New(goldmark.WithExtensions(extension.TaskList))
	reader := text.NewReader(source)
	doc := md.Parser().Parse(reader)

	occurrences := map[string]int{}
	result := map[string]bool{}
	ordered := make([]string, 0)

	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if n.Kind() != ast.KindListItem {
			return ast.WalkContinue, nil
		}

		// Find the TaskCheckBox child. In goldmark, the TaskCheckBox is an
		// inline node inside a TextBlock (tight lists) or Paragraph (loose
		// lists) child of the ListItem.
		var checkbox *east.TaskCheckBox
		for child := n.FirstChild(); child != nil; child = child.NextSibling() {
			if child.Kind() == ast.KindParagraph || child.Kind() == ast.KindTextBlock {
				for gc := child.FirstChild(); gc != nil; gc = gc.NextSibling() {
					if gc.Kind() == east.KindTaskCheckBox {
						cb, ok := gc.(*east.TaskCheckBox)
						if ok {
							checkbox = cb
						}
						break
					}
				}
				if checkbox != nil {
					break
				}
			}
		}
		if checkbox == nil {
			return ast.WalkContinue, nil
		}

		labelText := extractCheckboxLabel(n, source)
		key := computeCheckboxKey(labelText, occurrences)
		result[key] = checkbox.IsChecked
		ordered = append(ordered, key)

		return ast.WalkContinue, nil
	})

	return result, ordered
}
```

- [ ] **Step 4: Update the two in-package callers to use `ExtractCheckboxes`**

In `internal/server/server.go`, change line 313 (inside `AddFile`):

```go
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			checkboxSrc, _ = ExtractCheckboxes(string(fullContent))
		}
```

And change line 399 (inside `AddUploadedFile`):

```go
	if entry.Type == FileTypeMarkdown {
		sources, _ := ExtractCheckboxes(content)
		if len(sources) > 0 {
			s.checkboxSources[entry.ID] = sources
		}
	}
```

And change line 1054 (inside `notifyFileChangedByPath`):

```go
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			newCheckboxSrc, _ = ExtractCheckboxes(string(fullContent))
		}
```

(Note: this step uses `_` to discard the ordered slice temporarily. Task 2 will thread it through. This step exists only to keep the code compiling after `ExtractCheckboxSources` is deleted.)

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `cd /vm-mo && go test ./internal/server/ -run TestExtractCheckboxes -v`
Expected: PASS for all subtests.

Run: `cd /vm-mo && go build ./...`
Expected: Build succeeds (no references to `ExtractCheckboxSources` remain).

- [ ] **Step 6: Commit**

```bash
cd /vm-mo && git add internal/server/checkbox.go internal/server/checkbox_test.go internal/server/server.go && git commit -m "refactor: return ordered checkbox keys from ExtractCheckboxes"
```

---

### Task 2: Backend — `checkboxOrderedKeys` state field

**Files:**
- Modify: `internal/server/server.go` (State struct, NewState, AddFile, AddUploadedFile, RemoveFile, notifyFileChangedByPath, GetCheckboxState)
- Modify: `internal/server/server_test.go` (newTestState helper, TestRemoveFileCleansUpCheckboxState)

- [ ] **Step 1: Write the failing test for `RemoveFile` cleanup of ordered keys**

In `internal/server/server_test.go`, update `TestRemoveFileCleansUpCheckboxState` (currently ending around line 2174) to also assert `checkboxOrderedKeys` cleanup:

```go
func TestRemoveFileCleansUpCheckboxState(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] Item\n"), 0o600)

	entry, err := s.AddFile(mdFile, DefaultGroup)
	if err != nil {
		t.Fatal(err)
	}

	// Manually add an override.
	s.mu.Lock()
	s.checkboxOverrides[entry.ID] = map[string]bool{"Item": true}
	s.mu.Unlock()

	s.RemoveFile(entry.ID)

	s.mu.RLock()
	_, hasSources := s.checkboxSources[entry.ID]
	_, hasOverrides := s.checkboxOverrides[entry.ID]
	_, hasOrdered := s.checkboxOrderedKeys[entry.ID]
	s.mu.RUnlock()

	if hasSources {
		t.Fatal("sources should be deleted after RemoveFile")
	}
	if hasOverrides {
		t.Fatal("overrides should be deleted after RemoveFile")
	}
	if hasOrdered {
		t.Fatal("orderedKeys should be deleted after RemoveFile")
	}
}
```

Also add a new test after it asserting `AddFile` populates `checkboxOrderedKeys`:

```go
func TestAddFilePopulatesCheckboxOrderedKeys(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] First\n- [x] Second\n"), 0o600)

	entry, err := s.AddFile(mdFile, DefaultGroup)
	if err != nil {
		t.Fatal(err)
	}

	s.mu.RLock()
	ordered := s.checkboxOrderedKeys[entry.ID]
	s.mu.RUnlock()

	if len(ordered) != 2 {
		t.Fatalf("got %d ordered keys, want 2", len(ordered))
	}
	if ordered[0] != "First" || ordered[1] != "Second" {
		t.Fatalf("ordered keys wrong: %v", ordered)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /vm-mo && go test ./internal/server/ -run 'TestRemoveFileCleansUpCheckboxState|TestAddFilePopulatesCheckboxOrderedKeys' -v`
Expected: FAIL — `s.checkboxOrderedKeys` undefined.

- [ ] **Step 3: Add the `checkboxOrderedKeys` field to `State`**

In `internal/server/server.go`, update the `State` struct around lines 196-197:

```go
	checkboxSources     map[string]map[string]bool // fileID → checkboxKey → source checked
	checkboxOverrides   map[string]map[string]bool // fileID → checkboxKey → overridden checked
	checkboxOrderedKeys map[string][]string        // fileID → keys in document order
```

And initialize it in `NewState` around lines 221-222:

```go
		checkboxSources:     make(map[string]map[string]bool),
		checkboxOverrides:   make(map[string]map[string]bool),
		checkboxOrderedKeys: make(map[string][]string),
```

- [ ] **Step 4: Initialize `checkboxOrderedKeys` in the test state helper**

In `internal/server/server_test.go`, update `newTestState` (around lines 33-43) to initialize the new map:

```go
	s := &State{
		groups:              make(map[string]*Group),
		subscribers:         make(map[chan sseEvent]struct{}),
		restartCh:           make(chan string, 1),
		shutdownCh:          make(chan struct{}, 1),
		watchedDirs:         make(map[string]int),
		fileChangeDebounce:  defaultFileChangeDebounce,
		fileChangeTimers:    make(map[string]*time.Timer),
		checkboxSources:     make(map[string]map[string]bool),
		checkboxOverrides:   make(map[string]map[string]bool),
		checkboxOrderedKeys: make(map[string][]string),
	}
```

- [ ] **Step 5: Populate `checkboxOrderedKeys` in `AddFile`**

In `internal/server/server.go`, update the `AddFile` region around lines 310-344:

Replace:
```go
	var checkboxSrc map[string]bool
	if fileType == FileTypeMarkdown {
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			checkboxSrc, _ = ExtractCheckboxes(string(fullContent))
		}
	}
```

With:
```go
	var checkboxSrc map[string]bool
	var checkboxOrdered []string
	if fileType == FileTypeMarkdown {
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			checkboxSrc, checkboxOrdered = ExtractCheckboxes(string(fullContent))
		}
	}
```

And further down, where the sources are assigned to state (around line 342-344), replace:
```go
	if len(checkboxSrc) > 0 {
		s.checkboxSources[entry.ID] = checkboxSrc
	}
```

With:
```go
	if len(checkboxSrc) > 0 {
		s.checkboxSources[entry.ID] = checkboxSrc
	}
	if len(checkboxOrdered) > 0 {
		s.checkboxOrderedKeys[entry.ID] = checkboxOrdered
	}
```

- [ ] **Step 6: Populate `checkboxOrderedKeys` in `AddUploadedFile`**

In `internal/server/server.go`, update the `AddUploadedFile` block around lines 398-403:

Replace:
```go
	if entry.Type == FileTypeMarkdown {
		sources, _ := ExtractCheckboxes(content)
		if len(sources) > 0 {
			s.checkboxSources[entry.ID] = sources
		}
	}
```

With (spec: "always, not conditional" — store ordered keys even if sources is empty, so that a markdown upload with no checkboxes still has a canonical empty slice):
```go
	if entry.Type == FileTypeMarkdown {
		sources, ordered := ExtractCheckboxes(content)
		if len(sources) > 0 {
			s.checkboxSources[entry.ID] = sources
		}
		s.checkboxOrderedKeys[entry.ID] = ordered
	}
```

- [ ] **Step 7: Delete `checkboxOrderedKeys[id]` in `RemoveFile`**

In `internal/server/server.go`, update `RemoveFile` at lines 560-561:

```go
				g.Files = append(g.Files[:i], g.Files[i+1:]...)
				delete(s.checkboxSources, id)
				delete(s.checkboxOverrides, id)
				delete(s.checkboxOrderedKeys, id)
```

- [ ] **Step 8: Populate `checkboxOrderedKeys` in `notifyFileChangedByPath`**

In `internal/server/server.go`, update `notifyFileChangedByPath` around lines 1050-1105.

Replace the extraction call (around line 1050-1056):
```go
	// Re-extract checkbox sources for reconciliation.
	var newCheckboxSrc map[string]bool
	if ft := DetectFileType(absPath); ft == FileTypeMarkdown {
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			newCheckboxSrc, _ = ExtractCheckboxes(string(fullContent))
		}
	}
```

With:
```go
	// Re-extract checkbox sources for reconciliation.
	var newCheckboxSrc map[string]bool
	var newCheckboxOrdered []string
	if ft := DetectFileType(absPath); ft == FileTypeMarkdown {
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			newCheckboxSrc, newCheckboxOrdered = ExtractCheckboxes(string(fullContent))
		}
	}
```

And inside the reconciliation loop (around lines 1076-1105), replace:
```go
					// Update sources.
					if len(newCheckboxSrc) > 0 {
						s.checkboxSources[entry.ID] = newCheckboxSrc
					} else {
						delete(s.checkboxSources, entry.ID)
					}
```

With:
```go
					// Update sources and ordered keys.
					if len(newCheckboxSrc) > 0 {
						s.checkboxSources[entry.ID] = newCheckboxSrc
					} else {
						delete(s.checkboxSources, entry.ID)
					}
					if len(newCheckboxOrdered) > 0 {
						s.checkboxOrderedKeys[entry.ID] = newCheckboxOrdered
					} else {
						delete(s.checkboxOrderedKeys, entry.ID)
					}
```

- [ ] **Step 9: Update `GetCheckboxState` to return ordered keys**

In `internal/server/server.go`, replace the full `GetCheckboxState` function (lines 1857-1888):

```go
// GetCheckboxState returns the sources, overrides, and ordered keys for a file.
func (s *State) GetCheckboxState(id string) (sources, overrides map[string]bool, orderedKeys []string, found bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Verify file exists.
	fileFound := false
	for _, g := range s.groups {
		for _, f := range g.Files {
			if f.ID == id {
				fileFound = true
				break
			}
		}
		if fileFound {
			break
		}
	}
	if !fileFound {
		return nil, nil, nil, false
	}

	src := s.checkboxSources[id]
	if src == nil {
		src = map[string]bool{}
	}
	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	ordered := s.checkboxOrderedKeys[id]
	if ordered == nil {
		ordered = []string{}
	}
	return src, ovr, ordered, true
}
```

- [ ] **Step 10: Update the single non-handler caller of `GetCheckboxState`**

In `internal/server/server.go`, the only caller outside of `handleGetCheckboxes` is in `notifyFileChangedByPath` around lines 1116-1119. Replace:

```go
	for _, cbID := range checkboxChangedIDs {
		src, ovr, _ := s.GetCheckboxState(cbID)
		s.broadcastCheckboxChanged(cbID, src, ovr)
	}
```

With:
```go
	for _, cbID := range checkboxChangedIDs {
		src, ovr, ordered, _ := s.GetCheckboxState(cbID)
		s.broadcastCheckboxChanged(cbID, src, ovr, ordered)
	}
```

(Note: `broadcastCheckboxChanged`'s new signature lands in Task 3. The code will not compile at the end of Task 2 — we land these two changes in the same task below by also updating the three other callers and the function itself here. Re-reading: there are multiple callers. Let's do them all now, because the compiler error would surface mid-Task 2 anyway.)

Callers of `GetCheckboxState` are:
- `notifyFileChangedByPath` line 1117
- `handleGetCheckboxes` line 2106

Callers of `broadcastCheckboxChanged` are:
- `notifyFileChangedByPath` line 1118
- `SetCheckbox` line 1941
- `UncheckAll` line 1996
- `CheckAll` line 2050

All must be updated atomically. Apply the following updates to `server.go` in this step:

In `SetCheckbox` (around lines 1931-1941), replace:
```go
	src := s.checkboxSources[id]
	if src == nil {
		src = map[string]bool{}
	}
	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	s.mu.Unlock()

	s.broadcastCheckboxChanged(id, src, ovr)
```

With:
```go
	src := s.checkboxSources[id]
	if src == nil {
		src = map[string]bool{}
	}
	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	ordered := s.checkboxOrderedKeys[id]
	if ordered == nil {
		ordered = []string{}
	}
	s.mu.Unlock()

	s.broadcastCheckboxChanged(id, src, ovr, ordered)
```

In `UncheckAll` (around lines 1986-1996), replace:
```go
	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	srcCopy := make(map[string]bool, len(src))
	for k, v := range src {
		srcCopy[k] = v
	}
	s.mu.Unlock()

	s.broadcastCheckboxChanged(id, srcCopy, ovr)
```

With:
```go
	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	srcCopy := make(map[string]bool, len(src))
	for k, v := range src {
		srcCopy[k] = v
	}
	ordered := s.checkboxOrderedKeys[id]
	if ordered == nil {
		ordered = []string{}
	}
	s.mu.Unlock()

	s.broadcastCheckboxChanged(id, srcCopy, ovr, ordered)
```

Make the equivalent change in `CheckAll` (around lines 2040-2050) — identical pattern, add `ordered` capture and pass it as the fourth arg.

In `handleGetCheckboxes` (around lines 2099-2116), replace:
```go
		sources, overrides, found := state.GetCheckboxState(id)
		if !found {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			Sources   map[string]bool `json:"sources"`
			Overrides map[string]bool `json:"overrides"`
		}{Sources: sources, Overrides: overrides})
```

With:
```go
		sources, overrides, orderedKeys, found := state.GetCheckboxState(id)
		if !found {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			Sources     map[string]bool `json:"sources"`
			Overrides   map[string]bool `json:"overrides"`
			OrderedKeys []string        `json:"orderedKeys"`
		}{Sources: sources, Overrides: overrides, OrderedKeys: orderedKeys})
```

- [ ] **Step 11: Update `broadcastCheckboxChanged` signature and payload**

In `internal/server/server.go`, replace the full `broadcastCheckboxChanged` function (lines 2082-2097):

```go
func (s *State) broadcastCheckboxChanged(id string, sources, overrides map[string]bool, orderedKeys []string) {
	b, err := json.Marshal(struct {
		FileID      string          `json:"fileId"`
		Sources     map[string]bool `json:"sources"`
		Overrides   map[string]bool `json:"overrides"`
		OrderedKeys []string        `json:"orderedKeys"`
	}{FileID: id, Sources: sources, Overrides: overrides, OrderedKeys: orderedKeys})
	if err != nil {
		slog.Error("broadcastCheckboxChanged", "err", err)
		return
	}
	s.sendEvent(sseEvent{
		Name: eventCheckboxChanged,
		Data: string(b),
	})
	s.markDirty()
}
```

- [ ] **Step 12: Run the backend tests and make sure they pass**

Run: `cd /vm-mo && go build ./...`
Expected: Build succeeds.

Run: `cd /vm-mo && go test ./internal/server/ -v`
Expected: All tests pass — including `TestExtractCheckboxes`, `TestRemoveFileCleansUpCheckboxState`, `TestAddFilePopulatesCheckboxOrderedKeys`, `TestHandleGetCheckboxes`, `TestHandlePutCheckbox`, `TestHandleDeleteCheckboxes`, `TestHandleCheckAll`, `TestCheckboxReconciliationOnFileChange`, `TestRestoreCheckboxOverrides`.

- [ ] **Step 13: Run the linter**

Run: `cd /vm-mo && make lint`
Expected: No new lint errors.

- [ ] **Step 14: Commit**

```bash
cd /vm-mo && git add internal/server/server.go internal/server/server_test.go && git commit -m "feat(server): track and expose ordered checkbox keys in state"
```

---

### Task 3: Backend — cross-parser ordering tests (blockquote & table)

**Files:**
- Modify: `internal/server/checkbox_test.go`

- [ ] **Step 1: Write the failing tests for blockquote and table scopes**

Append to the `TestExtractCheckboxes` function in `internal/server/checkbox_test.go`:

```go
	t.Run("checkbox inside blockquote", func(t *testing.T) {
		md := "> - [ ] Quoted task\n> - [x] Quoted done\n"
		sources, ordered := ExtractCheckboxes(md)
		// Whatever goldmark's position, the two task-list items must be
		// extracted in document order. If goldmark drops them entirely that
		// is also acceptable (empty result) — the invariant is count and
		// order consistency with remark-gfm, asserted via the frontend tests.
		if len(ordered) != len(sources) {
			t.Fatalf("ordered len %d != sources len %d", len(ordered), len(sources))
		}
		if len(ordered) == 2 {
			if ordered[0] != "Quoted task" || ordered[1] != "Quoted done" {
				t.Fatalf("blockquote order wrong: %v", ordered)
			}
		}
	})

	t.Run("checkbox outside list is ignored", func(t *testing.T) {
		// Raw HTML checkbox should not appear in the extracted set — goldmark
		// only recognises checkboxes inside the TaskList extension scope.
		md := "Some paragraph with <input type=\"checkbox\"> inside.\n\n- [ ] Real task\n"
		sources, ordered := ExtractCheckboxes(md)
		if len(sources) != 1 {
			t.Fatalf("got %d sources, want 1 (raw HTML checkbox must be ignored)", len(sources))
		}
		if len(ordered) != 1 || ordered[0] != "Real task" {
			t.Fatalf("ordered = %v", ordered)
		}
	})

	t.Run("multiple lists preserve document order", func(t *testing.T) {
		md := "- [ ] Alpha\n\nSome text\n\n- [ ] Beta\n- [x] Gamma\n"
		_, ordered := ExtractCheckboxes(md)
		want := []string{"Alpha", "Beta", "Gamma"}
		if len(ordered) != 3 {
			t.Fatalf("got %d ordered keys, want 3", len(ordered))
		}
		for i, k := range want {
			if ordered[i] != k {
				t.Fatalf("ordered[%d] = %q, want %q", i, ordered[i], k)
			}
		}
	})
```

- [ ] **Step 2: Run the tests to verify them**

Run: `cd /vm-mo && go test ./internal/server/ -run TestExtractCheckboxes -v`
Expected: All subtests pass (the existing implementation of `ExtractCheckboxes` already handles these cases correctly — these tests pin the behaviour against future regressions).

- [ ] **Step 3: Commit**

```bash
cd /vm-mo && git add internal/server/checkbox_test.go && git commit -m "test(server): pin cross-parser checkbox ordering invariants"
```

---

### Task 4: Frontend — add `orderedKeys` to the `CheckboxState` API type

**Files:**
- Modify: `internal/frontend/src/hooks/useApi.ts`

- [ ] **Step 1: Update the `CheckboxState` interface**

In `internal/frontend/src/hooks/useApi.ts`, replace the interface at lines 103-106:

```typescript
export interface CheckboxState {
  sources: Record<string, boolean>;
  overrides: Record<string, boolean>;
  orderedKeys: string[];
}
```

- [ ] **Step 2: Verify the frontend still type-checks**

Run: `cd /vm-mo/internal/frontend && pnpm exec tsc --noEmit`
Expected: Compilation errors in `useCheckboxState.ts` where the fetched object is destructured without `orderedKeys`. We'll fix these in Task 6. If there are errors anywhere *else* that are not directly about the new field, report them.

(Expected errors should be limited to: `useCheckboxState.ts` property-access sites. This is intentional — each task lands a compilable piece, and this one task produces a transient compile error that the next task resolves. Alternative: fold this into Task 6. For plan hygiene we fold it.)

- [ ] **Step 3: Do NOT commit this task standalone**

Continue directly into Task 5 — they form a single atomic change. The commit lands at the end of Task 6.

---

### Task 5: Frontend — plumb `orderedKeys` through SSE

**Files:**
- Modify: `internal/frontend/src/hooks/useSSE.ts`
- Modify: `internal/frontend/src/App.tsx`

- [ ] **Step 1: Update `SSECallbacks.onCheckboxChanged` signature**

In `internal/frontend/src/hooks/useSSE.ts`, replace lines 3-11:

```typescript
interface SSECallbacks {
  onUpdate: () => void;
  onFileChanged?: (fileId: string) => void;
  onCheckboxChanged?: (
    fileId: string,
    sources: Record<string, boolean>,
    overrides: Record<string, boolean>,
    orderedKeys: string[],
  ) => void;
}
```

And update the event handler around lines 58-65 to forward the new field:

```typescript
      es.addEventListener("checkbox-changed", (e) => {
        try {
          const data = JSON.parse(e.data);
          callbacksRef.current.onCheckboxChanged?.(
            data.fileId,
            data.sources,
            data.overrides,
            data.orderedKeys ?? [],
          );
        } catch {
          // ignore malformed data
        }
      });
```

- [ ] **Step 2: Update `App.tsx` to forward `orderedKeys` through the custom event**

In `internal/frontend/src/App.tsx`, replace the `onCheckboxChanged` callback (lines 210-216):

```typescript
    onCheckboxChanged: (fileId, sources, overrides, orderedKeys) => {
      window.dispatchEvent(
        new CustomEvent("mo-checkbox-changed", {
          detail: { fileId, sources, overrides, orderedKeys },
        }),
      );
    },
```

- [ ] **Step 3: Continue directly into Task 6**

Do not commit yet — Task 6 completes the frontend state plumbing and lands all three files in a single commit.

---

### Task 6: Frontend — `useCheckboxState` stores `orderedKeys` and `checkboxesLoaded`

**Files:**
- Modify: `internal/frontend/src/hooks/useCheckboxState.ts`

- [ ] **Step 1: Update the hook**

Replace the full contents of `internal/frontend/src/hooks/useCheckboxState.ts` with:

```typescript
import { useState, useCallback, useEffect, useRef } from "react";
import {
  fetchCheckboxes,
  toggleCheckbox,
  uncheckAllCheckboxes,
  checkAllCheckboxes,
} from "./useApi";

interface CheckboxStateResult {
  getChecked: (key: string) => boolean;
  toggle: (key: string) => void;
  uncheckAll: () => void;
  checkAll: () => void;
  hasCheckboxes: boolean;
  totalCheckboxes: number;
  /** Ordered checkbox keys in document order, authored by the backend. */
  orderedKeys: string[];
  /** True once the first fetchCheckboxes call for this fileId has resolved or rejected. */
  checkboxesLoaded: boolean;
  /** Monotonically increasing counter that bumps on every state change. */
  checkboxRevision: number;
}

export function useCheckboxState(fileId: string): CheckboxStateResult {
  const [sources, setSources] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [orderedKeys, setOrderedKeys] = useState<string[]>([]);
  const [checkboxesLoaded, setCheckboxesLoaded] = useState(false);
  const [checkboxRevision, setCheckboxRevision] = useState(0);
  const sourcesRef = useRef(sources);
  const overridesRef = useRef(overrides);

  // Keep refs in sync for use in callbacks.
  sourcesRef.current = sources;
  overridesRef.current = overrides;

  // Fetch initial state. Reset `checkboxesLoaded` on fileId change so the
  // renderer gates re-rendering until the new file's ordered keys arrive.
  useEffect(() => {
    let cancelled = false;
    setCheckboxesLoaded(false);
    fetchCheckboxes(fileId)
      .then((data) => {
        if (!cancelled) {
          setSources(data.sources);
          setOverrides(data.overrides);
          setOrderedKeys(data.orderedKeys ?? []);
          setCheckboxesLoaded(true);
        }
      })
      .catch(() => {
        // File may not exist yet or have no checkboxes.
        if (!cancelled) {
          setSources({});
          setOverrides({});
          setOrderedKeys([]);
          setCheckboxesLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  // Listen for SSE-dispatched checkbox change events via custom event.
  // App.tsx dispatches "mo-checkbox-changed" when the SSE event fires.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.fileId === fileId) {
        setSources(detail.sources);
        setOverrides(detail.overrides);
        if (Array.isArray(detail.orderedKeys)) {
          setOrderedKeys(detail.orderedKeys);
        }
        setCheckboxRevision((r) => r + 1);
      }
    };
    window.addEventListener("mo-checkbox-changed", handler);
    return () => window.removeEventListener("mo-checkbox-changed", handler);
  }, [fileId]);

  const getChecked = useCallback(
    (key: string): boolean => {
      if (key in overrides) {
        return overrides[key];
      }
      return sources[key] ?? false;
    },
    [sources, overrides],
  );

  const toggle = useCallback(
    (key: string) => {
      const currentChecked =
        key in overridesRef.current
          ? overridesRef.current[key]
          : (sourcesRef.current[key] ?? false);
      const newChecked = !currentChecked;
      toggleCheckbox(fileId, key, newChecked).catch(() => {
        // Error handled silently — SSE will provide authoritative state.
      });
    },
    [fileId],
  );

  const uncheckAll = useCallback(() => {
    uncheckAllCheckboxes(fileId).catch(() => {
      // Error handled silently — SSE will provide authoritative state.
    });
  }, [fileId]);

  const checkAll = useCallback(() => {
    checkAllCheckboxes(fileId).catch(() => {
      // Error handled silently — SSE will provide authoritative state.
    });
  }, [fileId]);

  const totalCheckboxes = Object.keys(sources).length;
  const hasCheckboxes = totalCheckboxes > 0;

  return {
    getChecked,
    toggle,
    uncheckAll,
    checkAll,
    hasCheckboxes,
    totalCheckboxes,
    orderedKeys,
    checkboxesLoaded,
    checkboxRevision,
  };
}
```

- [ ] **Step 2: Type-check the frontend**

Run: `cd /vm-mo/internal/frontend && pnpm exec tsc --noEmit`
Expected: No type errors (the `MarkdownRenderer.tsx` destructure of `useCheckboxState` does not yet reference the new fields, which is a legal narrowing of the return type).

- [ ] **Step 3: Commit Tasks 4 + 5 + 6 together**

```bash
cd /vm-mo && git add internal/frontend/src/hooks/useApi.ts internal/frontend/src/hooks/useSSE.ts internal/frontend/src/App.tsx internal/frontend/src/hooks/useCheckboxState.ts && git commit -m "feat(frontend): plumb orderedKeys and checkboxesLoaded through state"
```

---

### Task 7: Frontend — rewrite the rehype plugin as `rehypeCheckboxIndices` (TDD)

**Files:**
- Create: `internal/frontend/src/plugins/rehypeCheckboxIndices.ts`
- Create: `internal/frontend/src/plugins/rehypeCheckboxIndices.test.ts`
- Delete: `internal/frontend/src/plugins/rehypeCheckboxKeys.ts`
- Delete: `internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `internal/frontend/src/plugins/rehypeCheckboxIndices.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { rehypeCheckboxIndices } from "./rehypeCheckboxIndices";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";

async function processMarkdown(md: string, orderedKeys: string[]) {
  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeCheckboxIndices, { orderedKeys })
    .use(rehypeStringify)
    .process(md);
  return String(result);
}

describe("rehypeCheckboxIndices plugin", () => {
  it("assigns keys in document order", async () => {
    const md = "- [ ] First item\n- [x] Second item\n";
    const html = await processMarkdown(md, ["First item", "Second item"]);
    expect(html).toContain('data-checkbox-key="First item"');
    expect(html).toContain('data-checkbox-key="Second item"');
    // Assert order by matching positions.
    const firstIdx = html.indexOf('data-checkbox-key="First item"');
    const secondIdx = html.indexOf('data-checkbox-key="Second item"');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("assigns disambiguated keys by index (ignoring text content)", async () => {
    // The plugin no longer inspects text — only order matters.
    const md = "- [ ] TODO\n- [ ] TODO\n- [x] TODO\n";
    const html = await processMarkdown(md, ["TODO", "TODO#2", "TODO#3"]);
    expect(html).toContain('data-checkbox-key="TODO"');
    expect(html).toContain('data-checkbox-key="TODO#2"');
    expect(html).toContain('data-checkbox-key="TODO#3"');
  });

  it("leaves excess checkboxes unkeyed when fewer keys than checkboxes", async () => {
    const md = "- [ ] One\n- [ ] Two\n- [ ] Three\n";
    const html = await processMarkdown(md, ["One", "Two"]);
    expect(html).toContain('data-checkbox-key="One"');
    expect(html).toContain('data-checkbox-key="Two"');
    // The third checkbox must not carry a key.
    const matches = html.match(/data-checkbox-key=/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("ignores excess keys when more keys than checkboxes", async () => {
    const md = "- [ ] Only\n";
    const html = await processMarkdown(md, ["Only", "Extra", "Phantom"]);
    expect(html).toContain('data-checkbox-key="Only"');
    expect(html).not.toContain('data-checkbox-key="Extra"');
    expect(html).not.toContain('data-checkbox-key="Phantom"');
  });

  it("ignores non-checkbox inputs", async () => {
    const md = 'Some text <input type="text" /> more text\n';
    const html = await processMarkdown(md, ["Only"]);
    expect(html).not.toContain("data-checkbox-key");
  });

  it("ignores raw HTML checkboxes outside a task-list-item", async () => {
    // Raw <input type="checkbox"> before a real task list — must not shift
    // the index. The key must land on the real task-list checkbox.
    const md = '<input type="checkbox"> raw html\n\n- [ ] Real task\n';
    const html = await processMarkdown(md, ["Real task"]);
    // The raw HTML checkbox has no key; the task-list checkbox gets "Real task".
    expect(html).toContain('data-checkbox-key="Real task"');
    const matches = html.match(/data-checkbox-key=/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("handles checkboxes in loose lists (wrapped in <p>)", async () => {
    const md = "- [ ] Task A\n\n  More details\n\n- [ ] Task B\n";
    const html = await processMarkdown(md, ["Task A", "Task B"]);
    expect(html).toContain('data-checkbox-key="Task A"');
    expect(html).toContain('data-checkbox-key="Task B"');
  });

  it("preserves existing data-* attributes on inputs", async () => {
    const md = "- [ ] Task\n";
    const html = await processMarkdown(md, ["Task"]);
    // Verify disabled attribute (rendered by remark-gfm by default) is kept.
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*data-checkbox-key="Task"/);
  });

  it("does not attach keys when orderedKeys is empty", async () => {
    const md = "- [ ] First\n- [ ] Second\n";
    const html = await processMarkdown(md, []);
    expect(html).not.toContain("data-checkbox-key");
  });
});
```

- [ ] **Step 2: Create the empty plugin file so imports resolve**

Create `internal/frontend/src/plugins/rehypeCheckboxIndices.ts` with a stub:

```typescript
import type { Root } from "hast";

interface RehypeCheckboxIndicesOptions {
  orderedKeys: string[];
}

export function rehypeCheckboxIndices(_options: RehypeCheckboxIndicesOptions) {
  return (_tree: Root) => {
    // stub
  };
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /vm-mo/internal/frontend && pnpm test src/plugins/rehypeCheckboxIndices.test.ts`
Expected: FAIL — stub does not assign keys.

- [ ] **Step 4: Implement the plugin**

Replace the contents of `internal/frontend/src/plugins/rehypeCheckboxIndices.ts` with:

```typescript
import { visit } from "unist-util-visit";
import type { Root, Element as HastElement } from "hast";

interface RehypeCheckboxIndicesOptions {
  orderedKeys: string[];
}

function hasClassName(el: HastElement | null | undefined, cls: string): boolean {
  if (!el || el.type !== "element") return false;
  const className = el.properties?.className;
  if (!Array.isArray(className)) return false;
  return className.includes(cls);
}

function isInsideTaskListItem(
  ancestors: readonly (HastElement | Root)[],
): boolean {
  // Walk ancestors from nearest → farthest. The nearest <li> ancestor must
  // have class "task-list-item". Loose lists wrap the checkbox in a <p>, so
  // we may traverse through <p> before reaching the <li>.
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (node.type !== "element") continue;
    const el = node as HastElement;
    if (el.tagName === "li") {
      return hasClassName(el, "task-list-item");
    }
  }
  return false;
}

export function rehypeCheckboxIndices({ orderedKeys }: RehypeCheckboxIndicesOptions) {
  return (tree: Root) => {
    let index = 0;
    visit(tree, "element", (node: HastElement, _idx, _parent, ancestors) => {
      if (node.tagName !== "input" || node.properties?.type !== "checkbox") {
        return;
      }
      // `ancestors` from unist-util-visit includes everything up to but not
      // including `node` itself, with the root first. Nearest ancestor is
      // ancestors[ancestors.length - 1].
      if (!isInsideTaskListItem(ancestors as readonly (HastElement | Root)[])) {
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

Note: `unist-util-visit` passes the ancestors array as the fourth argument when the visitor signature requests it. If the installed version's visitor signature does not supply ancestors, fall back to manually tracking the ancestor stack by using a custom recursive walk. Verify this in Step 5 — if tests fail for the "loose list" or "raw HTML" cases with the `visit` API, replace the implementation with a hand-written recursive walker that maintains an explicit ancestors array.

- [ ] **Step 5: Run the tests**

Run: `cd /vm-mo/internal/frontend && pnpm test src/plugins/rehypeCheckboxIndices.test.ts`
Expected: All 9 tests PASS.

If any test fails due to `unist-util-visit` not supplying ancestors, replace the plugin body with:

```typescript
export function rehypeCheckboxIndices({ orderedKeys }: RehypeCheckboxIndicesOptions) {
  return (tree: Root) => {
    let index = 0;
    const walk = (node: Root | HastElement, ancestors: HastElement[]) => {
      if (node.type === "element") {
        const el = node as HastElement;
        if (el.tagName === "input" && el.properties?.type === "checkbox") {
          if (isInsideTaskListItem(ancestors)) {
            if (index < orderedKeys.length) {
              el.properties = el.properties ?? {};
              el.properties["dataCheckboxKey"] = orderedKeys[index];
            }
            index++;
          }
          return;
        }
      }
      const children = (node as { children?: (HastElement | unknown)[] }).children ?? [];
      const nextAncestors =
        node.type === "element" ? [...ancestors, node as HastElement] : ancestors;
      for (const child of children) {
        if ((child as { type?: string }).type === "element") {
          walk(child as HastElement, nextAncestors);
        }
      }
    };
    walk(tree, []);
  };
}
```

Re-run the tests until they pass.

- [ ] **Step 6: Delete the old plugin and its tests**

```bash
cd /vm-mo && rm internal/frontend/src/plugins/rehypeCheckboxKeys.ts internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts
```

- [ ] **Step 7: Type-check the frontend**

Run: `cd /vm-mo/internal/frontend && pnpm exec tsc --noEmit`
Expected: Compile error in `MarkdownRenderer.tsx` (it still imports from `rehypeCheckboxKeys`). That is fixed in Task 8. Do not commit yet.

---

### Task 8: Frontend — wire the new plugin into `MarkdownRenderer` and gate on `checkboxesLoaded`

**Files:**
- Modify: `internal/frontend/src/renderers/MarkdownRenderer.tsx`

- [ ] **Step 1: Update the plugin import**

In `internal/frontend/src/renderers/MarkdownRenderer.tsx`, replace line 10:

```typescript
import { rehypeCheckboxIndices } from "../plugins/rehypeCheckboxIndices";
```

- [ ] **Step 2: Destructure `orderedKeys` and `checkboxesLoaded` from the hook**

In `internal/frontend/src/renderers/MarkdownRenderer.tsx`, replace the `useCheckboxState` destructuring (around lines 389-390):

```typescript
  const {
    getChecked,
    toggle,
    uncheckAll,
    checkAll,
    hasCheckboxes,
    totalCheckboxes,
    orderedKeys,
    checkboxesLoaded,
    checkboxRevision,
  } = useCheckboxState(fileId);
```

- [ ] **Step 3: Track the previously rendered content for render-gating**

Just above the `renderedContent` useMemo (around line 584), add a ref for caching the previously rendered node so file switches keep showing the prior content until the new keys arrive:

```typescript
  const previousRenderedRef = useRef<React.ReactNode>(null);
```

- [ ] **Step 4: Update the `renderedContent` useMemo**

In `internal/frontend/src/renderers/MarkdownRenderer.tsx`, replace the `renderedContent` useMemo (lines 584-610) with:

```typescript
  const renderedContent = useMemo(() => {
    if (isRawView) {
      const node = <RawView content={content} />;
      previousRenderedRef.current = node;
      return node;
    }
    // Gate interactive rendering on checkbox keys being ready. While the
    // initial fetch is in flight, render the previously rendered tree (if
    // any) to avoid a flicker where checkboxes briefly appear unkeyed and
    // therefore disabled. On file switch, `checkboxesLoaded` resets to
    // false inside useCheckboxState and flips true once the new fetch
    // resolves.
    if (!checkboxesLoaded) {
      return previousRenderedRef.current ?? null;
    }
    const base = parsed ? parsed.content : content;
    const md = fileName.toLowerCase().endsWith(".mdx") ? stripMdxSyntax(base) : base;
    const node = (
      <>
        {parsed && <FrontmatterBlock yaml={parsed.yaml} />}
        <Markdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[
            rehypeRaw,
            [rehypeCheckboxIndices, { orderedKeys }],
            [rehypeSanitize, sanitizeSchema],
            rehypeGithubAlerts,
            rehypeSlug,
            rehypeKatex,
          ]}
          components={components}
        >
          {md}
        </Markdown>
      </>
    );
    previousRenderedRef.current = node;
    return node;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, isRawView, parsed, components, fileName, checkboxRevision, checkboxesLoaded, orderedKeys]);
```

- [ ] **Step 5: Type-check the frontend**

Run: `cd /vm-mo/internal/frontend && pnpm exec tsc --noEmit`
Expected: No type errors.

- [ ] **Step 6: Run the frontend tests**

Run: `cd /vm-mo/internal/frontend && pnpm test`
Expected: All tests pass, including the new `rehypeCheckboxIndices.test.ts`.

- [ ] **Step 7: Run the frontend linter and formatter check**

Run: `cd /vm-mo/internal/frontend && pnpm run lint && pnpm run fmt:check`
Expected: No errors.

- [ ] **Step 8: Commit Tasks 7 + 8 together**

```bash
cd /vm-mo && git add internal/frontend/src/plugins/rehypeCheckboxIndices.ts internal/frontend/src/plugins/rehypeCheckboxIndices.test.ts internal/frontend/src/renderers/MarkdownRenderer.tsx && git rm internal/frontend/src/plugins/rehypeCheckboxKeys.ts internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts && git commit -m "feat(frontend): switch to index-based checkbox key assignment"
```

---

### Task 9: Full-stack verification

**Files:** (none modified)

- [ ] **Step 1: Run the full Go test suite**

Run: `cd /vm-mo && go test ./...`
Expected: All packages pass.

- [ ] **Step 2: Run the Go linter**

Run: `cd /vm-mo && make lint`
Expected: No errors.

- [ ] **Step 3: Run the full frontend test suite**

Run: `cd /vm-mo/internal/frontend && pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Build the full binary**

Run: `cd /vm-mo && make build`
Expected: `make build` completes (frontend build + Go build with embedded assets).

- [ ] **Step 5: Manual smoke test**

Run: `cd /vm-mo && make dev ARGS="testdata/basic.md"`

Verify in the browser:
- Checkboxes in `testdata/basic.md` (and any other file with checkboxes) render interactively on first load.
- Clicking a checkbox toggles it; reloading the page preserves the override (server-side state).
- Editing the file on disk (add/remove/reorder a checkbox) reconciles overrides correctly and the browser updates via SSE.
- Switching between files in the sidebar does not leave a flicker of disabled checkboxes.
- A markdown file containing a raw HTML `<input type="checkbox">` followed by a real task list has the key attached to the task list item, not to the raw HTML checkbox.

- [ ] **Step 6: Commit verification results**

No code changes in this task — the commit from Task 8 is the final one. If the smoke test revealed issues, diagnose and fix them as individual small commits before declaring the plan complete.

---

## Self-Review Notes

- **Spec coverage:** every section of the spec maps to a task:
  - Backend `ExtractCheckboxes` (spec §Backend) → Task 1
  - `checkboxOrderedKeys` state field + populate/delete at every site (spec §Backend) → Task 2
  - `GetCheckboxState` signature, `handleGetCheckboxes` response, `broadcastCheckboxChanged` signature (spec §API) → Task 2
  - Cross-parser ordering tests (spec §Testing — blockquote, table, raw HTML) → Tasks 3 and 7
  - `CheckboxState.orderedKeys` type (spec §Frontend plumbing) → Task 4
  - `useSSE.onCheckboxChanged` + `App.tsx` forwarding (spec §Frontend plumbing) → Task 5
  - `useCheckboxState` ordered keys + `checkboxesLoaded` flag + reset on `fileId` change (spec §Frontend plumbing + §Render-gating) → Task 6
  - Rehype plugin rewrite (spec §Frontend simplification) → Task 7
  - `MarkdownRenderer` plugin option + render-gating + dependency array (spec §Frontend plumbing + §Render-gating) → Task 8
  - Deletion of old plugin + test cases (spec §Frontend simplification) → Task 7
- **No placeholders:** all code blocks are concrete; no "TBD" or "similar to X" references.
- **Type consistency:** `ExtractCheckboxes` returns `(map[string]bool, []string)` everywhere; `broadcastCheckboxChanged` takes `(id, sources, overrides, orderedKeys)` everywhere; `GetCheckboxState` returns `(sources, overrides, orderedKeys, found)` everywhere; `CheckboxStateResult` exposes `orderedKeys`, `checkboxesLoaded`, `checkboxRevision` consistently across the hook and the renderer.
- **Migration:** backup format is untouched (spec §Migration). `RestoreCheckboxOverrides` continues to operate on the already-populated sources map — ordered keys are always fresh from disk and never persisted.
