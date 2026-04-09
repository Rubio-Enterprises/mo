# Server-Side Checkbox State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move checkbox override state from client-side localStorage to the Go server for multi-client sync and backup/restore integration.

**Architecture:** Add `checkboxSources` and `checkboxOverrides` maps to the server `State` struct, expose three new API endpoints (GET/PUT/DELETE), broadcast changes via a new `checkbox-changed` SSE event, and replace the frontend `useCheckboxOverrides` hook with a new `useCheckboxState` hook that fetches from the server.

**Tech Stack:** Go 1.26+, goldmark (GFM markdown parser), React 19, TypeScript, Vitest

---

## File Structure

### Go (backend)

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `internal/server/checkbox.go` | Checkbox key extraction from markdown via goldmark, `computeCheckboxKey`, `ExtractCheckboxSources` |
| Create | `internal/server/checkbox_test.go` | Tests for checkbox extraction parity with TypeScript |
| Modify | `internal/server/server.go` | State struct fields, `NewState`, `AddFile`, `AddUploadedFile`, `RemoveFile`, `snapshotRestoreData`, `notifyFileChangedByPath`, new handlers, route registration |
| Modify | `go.mod` / `go.sum` | Add `github.com/yuin/goldmark` dependency |

### TypeScript (frontend)

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `internal/frontend/src/hooks/useCheckboxState.ts` | Server-backed checkbox state hook (fetch, SSE, toggle, uncheckAll) |
| Modify | `internal/frontend/src/hooks/useApi.ts` | Add `fetchCheckboxes`, `toggleCheckbox`, `uncheckAllCheckboxes` API functions |
| Modify | `internal/frontend/src/hooks/useSSE.ts` | Add `onCheckboxChanged` callback to `SSECallbacks` |
| Modify | `internal/frontend/src/renderers/MarkdownRenderer.tsx` | Swap `useCheckboxOverrides` for `useCheckboxState` |
| Modify | `internal/frontend/src/components/App.tsx` | Wire `onCheckboxChanged` SSE callback |
| Delete | `internal/frontend/src/hooks/useCheckboxOverrides.ts` | Replaced by server state |
| Delete | `internal/frontend/src/hooks/useCheckboxOverrides.test.ts` | Tests for removed hook |

---

### Task 1: Add goldmark dependency

**Files:**
- Modify: `go.mod`

- [ ] **Step 1: Add goldmark dependency**

```bash
cd /vm-mo && go get github.com/yuin/goldmark@latest
```

- [ ] **Step 2: Verify it resolves**

```bash
cd /vm-mo && go mod tidy
```

Expected: `go.mod` and `go.sum` updated with goldmark entry.

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum && git commit -m "build: add goldmark markdown parser dependency"
```

---

### Task 2: Implement Go checkbox key extraction

**Files:**
- Create: `internal/server/checkbox.go`
- Create: `internal/server/checkbox_test.go`

- [ ] **Step 1: Write the failing tests**

Create `internal/server/checkbox_test.go`:

```go
package server

import (
	"testing"
)

func TestComputeCheckboxKey(t *testing.T) {
	t.Run("returns trimmed text for first occurrence", func(t *testing.T) {
		counts := map[string]int{}
		key := computeCheckboxKey("  Buy milk  ", counts)
		if key != "Buy milk" {
			t.Fatalf("got %q, want %q", key, "Buy milk")
		}
		if counts["Buy milk"] != 1 {
			t.Fatalf("got count %d, want 1", counts["Buy milk"])
		}
	})

	t.Run("disambiguates duplicate labels", func(t *testing.T) {
		counts := map[string]int{}
		k1 := computeCheckboxKey("TODO", counts)
		k2 := computeCheckboxKey("TODO", counts)
		k3 := computeCheckboxKey("TODO", counts)
		if k1 != "TODO" {
			t.Fatalf("first: got %q, want %q", k1, "TODO")
		}
		if k2 != "TODO#2" {
			t.Fatalf("second: got %q, want %q", k2, "TODO#2")
		}
		if k3 != "TODO#3" {
			t.Fatalf("third: got %q, want %q", k3, "TODO#3")
		}
	})

	t.Run("uses __empty for blank labels", func(t *testing.T) {
		counts := map[string]int{}
		k1 := computeCheckboxKey("", counts)
		k2 := computeCheckboxKey("   ", counts)
		if k1 != "__empty" {
			t.Fatalf("first: got %q, want %q", k1, "__empty")
		}
		if k2 != "__empty#2" {
			t.Fatalf("second: got %q, want %q", k2, "__empty#2")
		}
	})
}

func TestExtractCheckboxSources(t *testing.T) {
	t.Run("basic items", func(t *testing.T) {
		md := "- [ ] First item\n- [x] Second item\n"
		sources := ExtractCheckboxSources(md)
		if len(sources) != 2 {
			t.Fatalf("got %d entries, want 2", len(sources))
		}
		if sources["First item"] != false {
			t.Fatal("First item should be false")
		}
		if sources["Second item"] != true {
			t.Fatal("Second item should be true")
		}
	})

	t.Run("duplicate labels", func(t *testing.T) {
		md := "- [ ] TODO\n- [ ] TODO\n- [x] TODO\n"
		sources := ExtractCheckboxSources(md)
		if len(sources) != 3 {
			t.Fatalf("got %d entries, want 3", len(sources))
		}
		if _, ok := sources["TODO"]; !ok {
			t.Fatal("missing key TODO")
		}
		if _, ok := sources["TODO#2"]; !ok {
			t.Fatal("missing key TODO#2")
		}
		if _, ok := sources["TODO#3"]; !ok {
			t.Fatal("missing key TODO#3")
		}
		if sources["TODO#3"] != true {
			t.Fatal("TODO#3 should be true")
		}
	})

	t.Run("strips inline formatting", func(t *testing.T) {
		md := "- [ ] **bold** and *italic* text\n"
		sources := ExtractCheckboxSources(md)
		if _, ok := sources["bold and italic text"]; !ok {
			t.Fatalf("expected key 'bold and italic text', got keys: %v", sources)
		}
	})

	t.Run("strips code spans and links", func(t *testing.T) {
		md := "- [ ] Use `fetch` to call [the API](https://example.com)\n"
		sources := ExtractCheckboxSources(md)
		if _, ok := sources["Use fetch to call the API"]; !ok {
			t.Fatalf("expected key 'Use fetch to call the API', got keys: %v", sources)
		}
	})

	t.Run("empty markdown returns empty map", func(t *testing.T) {
		sources := ExtractCheckboxSources("")
		if len(sources) != 0 {
			t.Fatalf("got %d entries, want 0", len(sources))
		}
	})

	t.Run("no checkboxes returns empty map", func(t *testing.T) {
		md := "# Hello\n\n- Regular list\n- Another item\n"
		sources := ExtractCheckboxSources(md)
		if len(sources) != 0 {
			t.Fatalf("got %d entries, want 0", len(sources))
		}
	})

	t.Run("uppercase X is checked", func(t *testing.T) {
		md := "- [X] Done\n"
		sources := ExtractCheckboxSources(md)
		if sources["Done"] != true {
			t.Fatal("uppercase X should be checked")
		}
	})

	t.Run("nested list excluded from label", func(t *testing.T) {
		md := "- [ ] Parent\n  - [ ] Child\n"
		sources := ExtractCheckboxSources(md)
		if _, ok := sources["Parent"]; !ok {
			t.Fatal("missing key Parent")
		}
		if _, ok := sources["Child"]; !ok {
			t.Fatal("missing key Child")
		}
	})
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /vm-mo && go test ./internal/server/ -run "TestComputeCheckboxKey|TestExtractCheckboxSources" -v
```

Expected: compilation error — `computeCheckboxKey` and `ExtractCheckboxSources` are not defined.

- [ ] **Step 3: Implement checkbox extraction**

Create `internal/server/checkbox.go`:

```go
package server

import (
	"fmt"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	east "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
)

// computeCheckboxKey generates a unique key for a checkbox item.
// Matches the TypeScript computeCheckboxKey algorithm in rehypeCheckboxKeys.ts.
func computeCheckboxKey(rawText string, occurrences map[string]int) string {
	base := strings.TrimSpace(rawText)
	if base == "" {
		base = "__empty"
	}
	occurrences[base]++
	count := occurrences[base]
	if count == 1 {
		return base
	}
	return fmt.Sprintf("%s#%d", base, count)
}

// extractNodeText recursively collects text content from an AST node,
// excluding nested lists. Mirrors extractHastText in rehypeCheckboxKeys.ts.
func extractNodeText(n ast.Node, source []byte) string {
	var sb strings.Builder
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		switch child.Kind() {
		case ast.KindList:
			// Skip nested lists — they are separate checkbox items.
			continue
		case ast.KindText, ast.KindString:
			leaf := child.(*ast.Text)
			sb.Write(leaf.Segment.Value(source))
		case ast.KindCodeSpan:
			// Code spans contain text children.
			for gc := child.FirstChild(); gc != nil; gc = gc.NextSibling() {
				if gc.Kind() == ast.KindText || gc.Kind() == ast.KindString {
					leaf := gc.(*ast.Text)
					sb.Write(leaf.Segment.Value(source))
				}
			}
		default:
			// Recurse into inline elements (emphasis, strong, links, etc.).
			sb.WriteString(extractNodeText(child, source))
		}
	}
	return sb.String()
}

// ExtractCheckboxSources parses markdown content and returns a map of
// checkbox key → source checked state. Keys are computed using the same
// algorithm as the frontend rehypeCheckboxKeys plugin.
func ExtractCheckboxSources(content string) map[string]bool {
	source := []byte(content)
	md := goldmark.New(goldmark.WithExtensions(extension.TaskList))
	reader := text.NewReader(source)
	doc := md.Parser().Parse(reader)

	occurrences := map[string]int{}
	result := map[string]bool{}

	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if n.Kind() != ast.KindListItem {
			return ast.WalkContinue, nil
		}

		// Find the TaskCheckBox child.
		var checkbox *east.TaskCheckBox
		for child := n.FirstChild(); child != nil; child = child.NextSibling() {
			if child.Kind() == east.KindTaskCheckBox {
				checkbox = child.(*east.TaskCheckBox)
				break
			}
			// In goldmark, the TaskCheckBox may be inside a Paragraph child.
			if child.Kind() == ast.KindParagraph {
				for gc := child.FirstChild(); gc != nil; gc = gc.NextSibling() {
					if gc.Kind() == east.KindTaskCheckBox {
						checkbox = gc.(*east.TaskCheckBox)
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

		// Extract label text from the list item, excluding nested lists and the checkbox itself.
		labelText := extractNodeText(n, source)
		key := computeCheckboxKey(labelText, occurrences)
		result[key] = checkbox.IsChecked

		return ast.WalkSkipChildren, nil
	})

	return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /vm-mo && go test ./internal/server/ -run "TestComputeCheckboxKey|TestExtractCheckboxSources" -v
```

Expected: all tests pass. If the goldmark AST structure differs from what's assumed (e.g., `TaskCheckBox` node location or text node types), adjust `extractNodeText` and the walk logic until all tests pass. The tests are the source of truth for key parity.

- [ ] **Step 5: Commit**

```bash
git add internal/server/checkbox.go internal/server/checkbox_test.go && git commit -m "feat: add Go checkbox key extraction with goldmark"
```

---

### Task 3: Add checkbox state to server State struct and RestoreData

**Files:**
- Modify: `internal/server/server.go:180-197` (State struct)
- Modify: `internal/server/server.go:201-226` (NewState)
- Modify: `internal/server/server.go:755-759` (RestoreData)
- Modify: `internal/server/server.go:799-827` (snapshotRestoreData)

- [ ] **Step 1: Add fields to State struct**

In `internal/server/server.go`, add two new fields to the `State` struct after `fileChangeTimers`:

```go
	checkboxSources   map[string]map[string]bool // fileID → checkboxKey → source checked
	checkboxOverrides map[string]map[string]bool // fileID → checkboxKey → overridden checked
```

- [ ] **Step 2: Initialize in NewState**

In the `NewState` function, add initialization after `fileChangeTimers`:

```go
		checkboxSources:   make(map[string]map[string]bool),
		checkboxOverrides: make(map[string]map[string]bool),
```

- [ ] **Step 3: Add to RestoreData**

In the `RestoreData` struct, add:

```go
	CheckboxOverrides map[string]map[string]bool `json:"checkboxOverrides,omitempty"`
```

- [ ] **Step 4: Include in snapshotRestoreData**

In `snapshotRestoreData()`, after the patterns block (after line 824), add:

```go
	if len(s.checkboxOverrides) > 0 {
		data.CheckboxOverrides = make(map[string]map[string]bool, len(s.checkboxOverrides))
		for fileID, overrides := range s.checkboxOverrides {
			if len(overrides) > 0 {
				cp := make(map[string]bool, len(overrides))
				for k, v := range overrides {
					cp[k] = v
				}
				data.CheckboxOverrides[fileID] = cp
			}
		}
	}
```

- [ ] **Step 5: Verify compilation**

```bash
cd /vm-mo && go build ./...
```

Expected: compiles without errors.

- [ ] **Step 6: Commit**

```bash
git add internal/server/server.go && git commit -m "feat: add checkbox state fields to State and RestoreData"
```

---

### Task 4: Populate checkbox sources on file add and clean up on remove

**Files:**
- Modify: `internal/server/server.go:250-338` (AddFile)
- Modify: `internal/server/server.go:340-384` (AddUploadedFile)
- Modify: `internal/server/server.go:524-575` (RemoveFile)

- [ ] **Step 1: Write tests for AddFile populating sources**

Add to `internal/server/server_test.go`:

```go
func TestAddFilePopulatesCheckboxSources(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] First\n- [x] Second\n"), 0o600)

	entry, err := s.AddFile(mdFile, DefaultGroup)
	if err != nil {
		t.Fatal(err)
	}

	s.mu.RLock()
	sources := s.checkboxSources[entry.ID]
	s.mu.RUnlock()

	if len(sources) != 2 {
		t.Fatalf("got %d sources, want 2", len(sources))
	}
	if sources["First"] != false {
		t.Fatal("First should be unchecked")
	}
	if sources["Second"] != true {
		t.Fatal("Second should be checked")
	}
}

func TestAddFileSkipsCheckboxesForNonMarkdown(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	goFile := filepath.Join(dir, "main.go")
	os.WriteFile(goFile, []byte("package main\n"), 0o600)

	entry, err := s.AddFile(goFile, DefaultGroup)
	if err != nil {
		t.Fatal(err)
	}

	s.mu.RLock()
	sources := s.checkboxSources[entry.ID]
	s.mu.RUnlock()

	if len(sources) != 0 {
		t.Fatalf("got %d sources for non-markdown, want 0", len(sources))
	}
}

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
	s.mu.RUnlock()

	if hasSources {
		t.Fatal("sources should be deleted after RemoveFile")
	}
	if hasOverrides {
		t.Fatal("overrides should be deleted after RemoveFile")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /vm-mo && go test ./internal/server/ -run "TestAddFilePopulatesCheckboxSources|TestAddFileSkipsCheckboxesForNonMarkdown|TestRemoveFileCleansUpCheckboxState" -v
```

Expected: failures — sources not populated yet.

- [ ] **Step 3: Populate sources in AddFile**

In `AddFile()`, after the title extraction block (after line 300 `title = extractTitle(string(head))`), still inside the `if fileType != FileTypeBinary` block, keep `head` available. Then after the file entry is created and appended (after line 326 `g.Files = append(g.Files, entry)`), add:

```go
	if entry.Type == FileTypeMarkdown && len(head) > 0 {
		sources := ExtractCheckboxSources(string(head))
		if len(sources) > 0 {
			s.checkboxSources[entry.ID] = sources
		}
	}
```

Note: `head` is only the first 8KB. For checkbox extraction we need the full file. Read the full content for markdown files instead. Replace the above with:

```go
	if entry.Type == FileTypeMarkdown {
		// Read full content for checkbox extraction (head is only first 8KB).
		if fullContent, err := os.ReadFile(absPath); err == nil {
			sources := ExtractCheckboxSources(string(fullContent))
			if len(sources) > 0 {
				s.checkboxSources[entry.ID] = sources
			}
		}
	}
```

This block goes inside the locked section (after line 326), so it reads the file while holding the lock. Since `AddFile` already does I/O before the lock (reading `head`), move this read before the lock instead. Place the full-content read right after the `head` read and title extraction (around line 300), storing it in a variable:

```go
	var checkboxSrc map[string]bool
	if fileType == FileTypeMarkdown {
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			checkboxSrc = ExtractCheckboxSources(string(fullContent))
		}
	}
```

Then inside the locked section, after `g.Files = append(g.Files, entry)` (line 326):

```go
	if len(checkboxSrc) > 0 {
		s.checkboxSources[entry.ID] = checkboxSrc
	}
```

- [ ] **Step 4: Populate sources in AddUploadedFile**

In `AddUploadedFile()`, after `g.Files = append(g.Files, entry)` (line 378), add:

```go
	if entry.Type == FileTypeMarkdown {
		sources := ExtractCheckboxSources(content)
		if len(sources) > 0 {
			s.checkboxSources[entry.ID] = sources
		}
	}
```

- [ ] **Step 5: Clean up in RemoveFile**

In `RemoveFile()`, after `found = true` (line 538), add:

```go
				delete(s.checkboxSources, id)
				delete(s.checkboxOverrides, id)
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /vm-mo && go test ./internal/server/ -run "TestAddFilePopulatesCheckboxSources|TestAddFileSkipsCheckboxesForNonMarkdown|TestRemoveFileCleansUpCheckboxState" -v
```

Expected: all pass.

- [ ] **Step 7: Run all existing tests to verify no regressions**

```bash
cd /vm-mo && go test ./internal/server/ -v
```

Expected: all existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add internal/server/server.go internal/server/server_test.go && git commit -m "feat: populate checkbox sources on file add, clean up on remove"
```

---

### Task 5: Add checkbox API endpoints and SSE event

**Files:**
- Modify: `internal/server/server.go:162-165` (add event constant)
- Modify: `internal/server/server.go:1231-1254` (NewHandler route registration)
- Modify: `internal/server/server.go` (add handler functions and State methods)

- [ ] **Step 1: Write tests for the checkbox API endpoints**

Add to `internal/server/server_test.go`:

```go
func TestHandleGetCheckboxes(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] Alpha\n- [x] Beta\n"), 0o600)

	entry, _ := s.AddFile(mdFile, DefaultGroup)
	handler := NewHandler(s)

	t.Run("returns sources and empty overrides", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/_/api/files/"+entry.ID+"/checkboxes", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200", w.Code)
		}
		var resp struct {
			Sources   map[string]bool `json:"sources"`
			Overrides map[string]bool `json:"overrides"`
		}
		json.NewDecoder(w.Body).Decode(&resp)
		if len(resp.Sources) != 2 {
			t.Fatalf("got %d sources, want 2", len(resp.Sources))
		}
		if resp.Sources["Alpha"] != false {
			t.Fatal("Alpha should be false")
		}
		if resp.Sources["Beta"] != true {
			t.Fatal("Beta should be true")
		}
		if len(resp.Overrides) != 0 {
			t.Fatalf("got %d overrides, want 0", len(resp.Overrides))
		}
	})

	t.Run("returns 404 for unknown file", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/_/api/files/deadbeef/checkboxes", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("got status %d, want 404", w.Code)
		}
	})
}

func TestHandlePutCheckbox(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] Alpha\n- [x] Beta\n"), 0o600)

	entry, _ := s.AddFile(mdFile, DefaultGroup)
	handler := NewHandler(s)

	t.Run("toggles checkbox and stores override", func(t *testing.T) {
		body := strings.NewReader(`{"checked": true}`)
		req := httptest.NewRequest("PUT", "/_/api/files/"+entry.ID+"/checkboxes/Alpha", body)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("got status %d, want 204", w.Code)
		}

		s.mu.RLock()
		overrides := s.checkboxOverrides[entry.ID]
		s.mu.RUnlock()
		if overrides["Alpha"] != true {
			t.Fatal("Alpha override should be true")
		}
	})

	t.Run("removes override when matching source", func(t *testing.T) {
		// Beta source is true. Setting checked=true should remove override.
		body := strings.NewReader(`{"checked": true}`)
		req := httptest.NewRequest("PUT", "/_/api/files/"+entry.ID+"/checkboxes/Beta", body)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("got status %d, want 204", w.Code)
		}

		s.mu.RLock()
		overrides := s.checkboxOverrides[entry.ID]
		s.mu.RUnlock()
		if _, exists := overrides["Beta"]; exists {
			t.Fatal("Beta override should be removed (matches source)")
		}
	})

	t.Run("handles URL-encoded keys", func(t *testing.T) {
		// Add a file with a space in the checkbox label.
		mdFile2 := filepath.Join(dir, "spaces.md")
		os.WriteFile(mdFile2, []byte("- [ ] Buy milk\n"), 0o600)
		entry2, _ := s.AddFile(mdFile2, DefaultGroup)

		body := strings.NewReader(`{"checked": true}`)
		req := httptest.NewRequest("PUT", "/_/api/files/"+entry2.ID+"/checkboxes/Buy%20milk", body)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("got status %d, want 204", w.Code)
		}

		s.mu.RLock()
		overrides := s.checkboxOverrides[entry2.ID]
		s.mu.RUnlock()
		if overrides["Buy milk"] != true {
			t.Fatal("Buy milk override should be true")
		}
	})

	t.Run("returns 404 for unknown file", func(t *testing.T) {
		body := strings.NewReader(`{"checked": true}`)
		req := httptest.NewRequest("PUT", "/_/api/files/deadbeef/checkboxes/Alpha", body)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("got status %d, want 404", w.Code)
		}
	})
}

func TestHandleDeleteCheckboxes(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] Alpha\n- [x] Beta\n- [x] Gamma\n"), 0o600)

	entry, _ := s.AddFile(mdFile, DefaultGroup)
	handler := NewHandler(s)

	// First, toggle Alpha to true (source is false).
	s.mu.Lock()
	s.checkboxOverrides[entry.ID] = map[string]bool{"Alpha": true}
	s.mu.Unlock()

	t.Run("unchecks all", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/_/api/files/"+entry.ID+"/checkboxes", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("got status %d, want 204", w.Code)
		}

		s.mu.RLock()
		overrides := s.checkboxOverrides[entry.ID]
		s.mu.RUnlock()

		// Alpha: source false, should have no override (unchecked = source).
		if _, exists := overrides["Alpha"]; exists {
			t.Fatal("Alpha override should be removed (source is already false)")
		}
		// Beta: source true, should have override false.
		if overrides["Beta"] != false {
			t.Fatal("Beta override should be false")
		}
		// Gamma: source true, should have override false.
		if overrides["Gamma"] != false {
			t.Fatal("Gamma override should be false")
		}
	})

	t.Run("returns 404 for unknown file", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/_/api/files/deadbeef/checkboxes", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("got status %d, want 404", w.Code)
		}
	})
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /vm-mo && go test ./internal/server/ -run "TestHandleGetCheckboxes|TestHandlePutCheckbox|TestHandleDeleteCheckboxes" -v
```

Expected: compilation errors — handlers not defined.

- [ ] **Step 3: Add event constant**

In `internal/server/server.go`, add to the constants block after `eventFileChanged`:

```go
	eventCheckboxChanged = "checkbox-changed"
```

- [ ] **Step 4: Add State methods for checkbox operations**

Add these methods to `internal/server/server.go`:

```go
// GetCheckboxState returns the sources and overrides for a file.
// Returns nil, nil if the file does not exist in any group.
func (s *State) GetCheckboxState(id string) (sources, overrides map[string]bool, found bool) {
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
		return nil, nil, false
	}

	src := s.checkboxSources[id]
	if src == nil {
		src = map[string]bool{}
	}
	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	return src, ovr, true
}

// SetCheckbox sets or removes a checkbox override for a file.
// Returns false if the file is not found.
func (s *State) SetCheckbox(id, key string, checked bool) bool {
	s.mu.Lock()

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
		s.mu.Unlock()
		return false
	}

	sourceVal := false
	if src, ok := s.checkboxSources[id]; ok {
		sourceVal = src[key]
	}

	if checked == sourceVal {
		// Matches source — remove override.
		if ovr, ok := s.checkboxOverrides[id]; ok {
			delete(ovr, key)
			if len(ovr) == 0 {
				delete(s.checkboxOverrides, id)
			}
		}
	} else {
		if s.checkboxOverrides[id] == nil {
			s.checkboxOverrides[id] = make(map[string]bool)
		}
		s.checkboxOverrides[id][key] = checked
	}

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
	return true
}

// UncheckAll sets all checkboxes to unchecked for a file.
// Returns false if the file is not found.
func (s *State) UncheckAll(id string) bool {
	s.mu.Lock()

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
		s.mu.Unlock()
		return false
	}

	src := s.checkboxSources[id]
	if len(src) == 0 {
		s.mu.Unlock()
		return true
	}

	newOverrides := make(map[string]bool)
	for key, sourceChecked := range src {
		if sourceChecked {
			newOverrides[key] = false
		}
	}

	// Remove any existing overrides for source-false keys.
	if len(newOverrides) > 0 {
		s.checkboxOverrides[id] = newOverrides
	} else {
		delete(s.checkboxOverrides, id)
	}

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
	return true
}

func (s *State) broadcastCheckboxChanged(id string, sources, overrides map[string]bool) {
	b, err := json.Marshal(struct {
		FileID    string          `json:"fileId"`
		Sources   map[string]bool `json:"sources"`
		Overrides map[string]bool `json:"overrides"`
	}{FileID: id, Sources: sources, Overrides: overrides})
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

- [ ] **Step 5: Add handler functions**

Add to `internal/server/server.go`:

```go
func handleGetCheckboxes(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}
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
	}
}

func handlePutCheckbox(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}
		key, err := url.PathUnescape(r.PathValue("key"))
		if err != nil {
			http.Error(w, "invalid key encoding", http.StatusBadRequest)
			return
		}

		var req struct {
			Checked bool `json:"checked"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if !state.SetCheckbox(id, key, req.Checked) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleDeleteCheckboxes(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}
		if !state.UncheckAll(id) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
```

- [ ] **Step 6: Register routes in NewHandler**

In `NewHandler()`, add these three routes after the existing `handleFileContent` registration (after line 1240):

```go
	mux.HandleFunc("GET /_/api/files/{id}/checkboxes", handleGetCheckboxes(state))
	mux.HandleFunc("PUT /_/api/files/{id}/checkboxes/{key}", handlePutCheckbox(state))
	mux.HandleFunc("DELETE /_/api/files/{id}/checkboxes", handleDeleteCheckboxes(state))
```

- [ ] **Step 7: Add `net/url` to imports if not already present**

Check the import block in `server.go`. If `net/url` is not listed, add it.

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd /vm-mo && go test ./internal/server/ -run "TestHandleGetCheckboxes|TestHandlePutCheckbox|TestHandleDeleteCheckboxes" -v
```

Expected: all pass.

- [ ] **Step 9: Run all Go tests**

```bash
cd /vm-mo && go test ./...
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add internal/server/server.go && git commit -m "feat: add checkbox API endpoints (GET/PUT/DELETE) and SSE event"
```

---

### Task 6: Add checkbox reconciliation on file change

**Files:**
- Modify: `internal/server/server.go:1005-1033` (notifyFileChangedByPath)

- [ ] **Step 1: Write test for reconciliation**

Add to `internal/server/server_test.go`:

```go
func TestCheckboxReconciliationOnFileChange(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := NewState(ctx)
	s.fileChangeDebounce = 0 // Disable debounce for testing.

	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] Alpha\n- [x] Beta\n- [ ] Gamma\n"), 0o600)

	entry, _ := s.AddFile(mdFile, DefaultGroup)

	// Set up overrides.
	s.mu.Lock()
	s.checkboxOverrides[entry.ID] = map[string]bool{
		"Alpha": true,  // Differs from source (false) — should survive.
		"Beta":  false,  // Differs from source (true) — should survive.
		"Gamma": false,  // Matches source (false) — should be pruned.
	}
	s.mu.Unlock()

	// Rewrite the file: remove Gamma, change Beta to unchecked.
	os.WriteFile(mdFile, []byte("- [ ] Alpha\n- [ ] Beta\n"), 0o600)

	// Trigger reconciliation.
	s.notifyFileChangedByPath(mdFile)

	s.mu.RLock()
	overrides := s.checkboxOverrides[entry.ID]
	sources := s.checkboxSources[entry.ID]
	s.mu.RUnlock()

	// Alpha: source is still false, override true — should remain.
	if overrides["Alpha"] != true {
		t.Fatal("Alpha override should survive (differs from source)")
	}
	// Beta: source changed to false, override is false — should be pruned (matches new source).
	if _, exists := overrides["Beta"]; exists {
		t.Fatal("Beta override should be pruned (matches new source)")
	}
	// Gamma: removed from file — should be pruned.
	if _, exists := overrides["Gamma"]; exists {
		t.Fatal("Gamma override should be pruned (key no longer in source)")
	}
	// Sources should be updated.
	if len(sources) != 2 {
		t.Fatalf("got %d sources, want 2", len(sources))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /vm-mo && go test ./internal/server/ -run TestCheckboxReconciliationOnFileChange -v
```

Expected: fails — reconciliation not implemented.

- [ ] **Step 3: Add reconciliation to notifyFileChangedByPath**

In `notifyFileChangedByPath()`, after the title extraction (line 1007) and before the lock (line 1012), add checkbox re-extraction:

```go
	// Re-extract checkbox sources for reconciliation.
	var newCheckboxSrc map[string]bool
	if ft := DetectFileType(absPath); ft == FileTypeMarkdown {
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			newCheckboxSrc = ExtractCheckboxSources(string(fullContent))
		}
	}
```

Then inside the locked section (after the title update loop ends, before `s.mu.Unlock()` at line 1024), add:

```go
	// Reconcile checkbox state.
	var checkboxChangedIDs []string
	if newCheckboxSrc != nil {
		for _, g := range s.groups {
			for _, entry := range g.Files {
				if entry.Path == absPath {
					// Update sources.
					if len(newCheckboxSrc) > 0 {
						s.checkboxSources[entry.ID] = newCheckboxSrc
					} else {
						delete(s.checkboxSources, entry.ID)
					}

					// Reconcile overrides.
					if ovr, ok := s.checkboxOverrides[entry.ID]; ok {
						changed := false
						for key, val := range ovr {
							srcVal, inSrc := newCheckboxSrc[key]
							if !inSrc || val == srcVal {
								delete(ovr, key)
								changed = true
							}
						}
						if len(ovr) == 0 {
							delete(s.checkboxOverrides, entry.ID)
						}
						if changed {
							checkboxChangedIDs = append(checkboxChangedIDs, entry.ID)
						}
					}
				}
			}
		}
	}
```

After the mutex is released and after `s.notifyFileChanged(ids)` (line 1032), add:

```go
	for _, cbID := range checkboxChangedIDs {
		src, ovr, _ := s.GetCheckboxState(cbID)
		s.broadcastCheckboxChanged(cbID, src, ovr)
	}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /vm-mo && go test ./internal/server/ -run TestCheckboxReconciliationOnFileChange -v
```

Expected: passes.

- [ ] **Step 5: Run all Go tests**

```bash
cd /vm-mo && go test ./...
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add internal/server/server.go internal/server/server_test.go && git commit -m "feat: reconcile checkbox overrides on file content change"
```

---

### Task 7: Restore checkbox overrides from backup

**Files:**
- Modify: `cmd/root.go:357-361` (backup restore path)

- [ ] **Step 1: Write test**

Add to `cmd/root_test.go`:

```go
func TestRestoreCheckboxOverrides(t *testing.T) {
	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] Alpha\n- [x] Beta\n"), 0o600)

	rd := &server.RestoreData{
		Groups: map[string][]string{
			"default": {mdFile},
		},
		CheckboxOverrides: map[string]map[string]bool{
			server.FileID(mdFile): {"Alpha": true},
		},
	}
	filesByGroup, _, _ := filterValidRestoreData(rd)
	if len(filesByGroup["default"]) != 1 {
		t.Fatal("file should be valid")
	}
	// CheckboxOverrides should be preserved through filterValidRestoreData.
	if len(rd.CheckboxOverrides) != 1 {
		t.Fatal("checkbox overrides should be preserved")
	}
}
```

- [ ] **Step 2: Add State method to restore overrides**

In `internal/server/server.go`, add:

```go
// RestoreCheckboxOverrides loads persisted checkbox overrides into the state.
// Should be called after all files have been added (so checkboxSources are populated).
func (s *State) RestoreCheckboxOverrides(overrides map[string]map[string]bool) {
	if len(overrides) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	for fileID, ovr := range overrides {
		src := s.checkboxSources[fileID]
		if src == nil {
			continue // File not loaded — skip stale overrides.
		}
		reconciled := make(map[string]bool)
		for key, val := range ovr {
			srcVal, inSrc := src[key]
			if !inSrc || val == srcVal {
				continue // Stale or matches source.
			}
			reconciled[key] = val
		}
		if len(reconciled) > 0 {
			s.checkboxOverrides[fileID] = reconciled
		}
	}
}
```

- [ ] **Step 3: Call RestoreCheckboxOverrides in cmd/root.go**

In `cmd/root.go`, in the `runServer` function, after all files, patterns, and uploaded files have been added (after line 1163 `state.AddUploadedFile(uf.Name, uf.Content, uf.Group)`), add:

```go
	if len(rd.CheckboxOverrides) > 0 {
		state.RestoreCheckboxOverrides(rd.CheckboxOverrides)
	}
```

Note: `rd` is the `server.RestoreData` variable declared at line 357. It is in scope here.

- [ ] **Step 4: Run tests**

```bash
cd /vm-mo && go test ./cmd/ -run TestRestoreCheckboxOverrides -v && go test ./...
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add internal/server/server.go cmd/root.go cmd/root_test.go && git commit -m "feat: restore checkbox overrides from backup on startup"
```

---

### Task 8: Add frontend API functions for checkboxes

**Files:**
- Modify: `internal/frontend/src/hooks/useApi.ts`

- [ ] **Step 1: Add API types and functions**

Add to the end of `internal/frontend/src/hooks/useApi.ts`:

```typescript
export interface CheckboxState {
  sources: Record<string, boolean>;
  overrides: Record<string, boolean>;
}

export async function fetchCheckboxes(id: string): Promise<CheckboxState> {
  const res = await fetch(`/_/api/files/${id}/checkboxes`);
  if (!res.ok) throw new Error("Failed to fetch checkboxes");
  return res.json();
}

export async function toggleCheckbox(id: string, key: string, checked: boolean): Promise<void> {
  const res = await fetch(`/_/api/files/${id}/checkboxes/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checked }),
  });
  if (!res.ok) throw new Error("Failed to toggle checkbox");
}

export async function uncheckAllCheckboxes(id: string): Promise<void> {
  const res = await fetch(`/_/api/files/${id}/checkboxes`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to uncheck all");
}
```

- [ ] **Step 2: Verify frontend compiles**

```bash
cd /vm-mo/internal/frontend && pnpm run build
```

Expected: builds without errors.

- [ ] **Step 3: Commit**

```bash
git add internal/frontend/src/hooks/useApi.ts && git commit -m "feat: add checkbox API functions to frontend"
```

---

### Task 9: Add checkbox-changed SSE event to useSSE

**Files:**
- Modify: `internal/frontend/src/hooks/useSSE.ts`

- [ ] **Step 1: Extend SSECallbacks interface**

In `useSSE.ts`, update the `SSECallbacks` interface:

```typescript
interface SSECallbacks {
  onUpdate: () => void;
  onFileChanged?: (fileId: string) => void;
  onCheckboxChanged?: (fileId: string, sources: Record<string, boolean>, overrides: Record<string, boolean>) => void;
}
```

- [ ] **Step 2: Add event listener**

After the `es.addEventListener("file-changed", ...)` block (around line 51), add:

```typescript
      es.addEventListener("checkbox-changed", (e) => {
        try {
          const data = JSON.parse(e.data);
          callbacksRef.current.onCheckboxChanged?.(data.fileId, data.sources, data.overrides);
        } catch {
          // ignore malformed data
        }
      });
```

- [ ] **Step 3: Verify frontend compiles**

```bash
cd /vm-mo/internal/frontend && pnpm run build
```

Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add internal/frontend/src/hooks/useSSE.ts && git commit -m "feat: add checkbox-changed SSE event listener"
```

---

### Task 10: Create useCheckboxState hook

**Files:**
- Create: `internal/frontend/src/hooks/useCheckboxState.ts`

- [ ] **Step 1: Create the hook**

Create `internal/frontend/src/hooks/useCheckboxState.ts`:

```typescript
import { useState, useCallback, useEffect, useRef } from "react";
import { fetchCheckboxes, toggleCheckbox, uncheckAllCheckboxes } from "./useApi";

interface CheckboxStateResult {
  getChecked: (key: string) => boolean;
  toggle: (key: string) => void;
  uncheckAll: () => void;
  hasCheckboxes: boolean;
}

export function useCheckboxState(fileId: string): CheckboxStateResult {
  const [sources, setSources] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const sourcesRef = useRef(sources);
  const overridesRef = useRef(overrides);

  // Keep refs in sync for use in callbacks.
  sourcesRef.current = sources;
  overridesRef.current = overrides;

  // Fetch initial state.
  useEffect(() => {
    let cancelled = false;
    fetchCheckboxes(fileId)
      .then((data) => {
        if (!cancelled) {
          setSources(data.sources);
          setOverrides(data.overrides);
        }
      })
      .catch(() => {
        // File may not exist yet or have no checkboxes.
        if (!cancelled) {
          setSources({});
          setOverrides({});
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
      const currentChecked = key in overridesRef.current ? overridesRef.current[key] : (sourcesRef.current[key] ?? false);
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

  const hasCheckboxes = Object.keys(sources).length > 0;

  return { getChecked, toggle, uncheckAll, hasCheckboxes };
}
```

- [ ] **Step 2: Verify frontend compiles**

```bash
cd /vm-mo/internal/frontend && pnpm run build
```

Expected: builds without errors.

- [ ] **Step 3: Commit**

```bash
git add internal/frontend/src/hooks/useCheckboxState.ts && git commit -m "feat: add useCheckboxState hook for server-backed checkbox state"
```

---

### Task 11: Wire up MarkdownRenderer to use server-side state

**Files:**
- Modify: `internal/frontend/src/renderers/MarkdownRenderer.tsx`
- Modify: `internal/frontend/src/components/App.tsx`

- [ ] **Step 1: Update MarkdownRenderer imports and hook usage**

In `MarkdownRenderer.tsx`:

Replace the import:
```typescript
import { useCheckboxOverrides } from "../hooks/useCheckboxOverrides";
```
with:
```typescript
import { useCheckboxState } from "../hooks/useCheckboxState";
```

In the `MarkdownRenderer` function body, replace:
```typescript
  const basename = fileName.split("/").pop() ?? fileName;
  const { getChecked, toggle, setCheckboxMap, uncheckAll, hasCheckboxes } =
    useCheckboxOverrides(basename);

  const onCheckboxMap = useCallback(
    (map: Map<string, boolean>) => {
      setCheckboxMap(map);
    },
    [setCheckboxMap],
  );
```

with:

```typescript
  const { getChecked, toggle, uncheckAll, hasCheckboxes } =
    useCheckboxState(fileId);
```

The `onCheckboxMap` callback is no longer needed for state management. However, `rehypeCheckboxKeys` still needs to run to assign `data-checkbox-key` attributes. Keep the rehype plugin in the pipeline but remove the `onCheckboxMap` callback.

In the `rehypePlugins` array, change:
```typescript
            [rehypeCheckboxKeys, { onCheckboxMap }],
```
to:
```typescript
            rehypeCheckboxKeys,
```

The `onCheckboxInfo` effect stays the same — `hasCheckboxes` now comes from `useCheckboxState`:
```typescript
  useEffect(() => {
    onCheckboxInfo?.({ hasCheckboxes, uncheckAll });
  }, [hasCheckboxes, uncheckAll, onCheckboxInfo]);
```

Also remove the `useCallback` import if `onCheckboxMap` was the only usage of it (check — `handleLinkClick` also uses it, so keep it).

- [ ] **Step 2: Wire SSE in App.tsx**

SSE checkbox events are bridged to `useCheckboxState` via a custom DOM event (`mo-checkbox-changed`), avoiding prop threading. `useCheckboxState` already listens for this event (see Task 10).

In `App.tsx`, add `onCheckboxChanged` to the `useSSE` call:

```typescript
useSSE({
  onUpdate: () => {
    loadGroups();
  },
  onFileChanged: (fileId) => {
    captureScrollPosition();
    setActiveFileId((current) => {
      if (current === fileId) {
        setContentRevision((r) => r + 1);
      }
      return current;
    });
  },
  onCheckboxChanged: (fileId, sources, overrides) => {
    window.dispatchEvent(
      new CustomEvent("mo-checkbox-changed", {
        detail: { fileId, sources, overrides },
      }),
    );
  },
});
```

- [ ] **Step 3: Verify frontend compiles**

```bash
cd /vm-mo/internal/frontend && pnpm run build
```

Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add internal/frontend/src/renderers/MarkdownRenderer.tsx internal/frontend/src/components/App.tsx && git commit -m "feat: wire MarkdownRenderer and App to use server-side checkbox state"
```

---

### Task 12: Remove old useCheckboxOverrides hook and tests

**Files:**
- Delete: `internal/frontend/src/hooks/useCheckboxOverrides.ts`
- Delete: `internal/frontend/src/hooks/useCheckboxOverrides.test.ts`

- [ ] **Step 1: Verify no remaining imports**

```bash
cd /vm-mo/internal/frontend && grep -r "useCheckboxOverrides" src/
```

Expected: no results (the import was replaced in Task 11).

- [ ] **Step 2: Delete files**

```bash
rm internal/frontend/src/hooks/useCheckboxOverrides.ts internal/frontend/src/hooks/useCheckboxOverrides.test.ts
```

- [ ] **Step 3: Verify build and tests**

```bash
cd /vm-mo/internal/frontend && pnpm run build && pnpm test
```

Expected: build succeeds, all remaining tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: remove useCheckboxOverrides hook (replaced by server state)"
```

---

### Task 13: Full integration test

**Files:** No new files — validation only.

- [ ] **Step 1: Run all Go tests**

```bash
cd /vm-mo && go test ./...
```

Expected: all pass.

- [ ] **Step 2: Run all frontend tests**

```bash
cd /vm-mo/internal/frontend && pnpm test
```

Expected: all pass.

- [ ] **Step 3: Run full build**

```bash
cd /vm-mo && make build
```

Expected: builds successfully (frontend + Go binary).

- [ ] **Step 4: Run linters**

```bash
cd /vm-mo && make lint && cd internal/frontend && pnpm run lint && pnpm run fmt:check
```

Expected: no lint errors.

- [ ] **Step 5: Manual smoke test**

```bash
cd /vm-mo && make dev ARGS="testdata/gfm.md"
```

Open the browser. Verify:
1. Checkboxes in the GFM test file render correctly
2. Clicking a checkbox toggles it
3. Opening a second browser tab shows the same checkbox state
4. Toggling in one tab updates the other tab in real-time
5. The "uncheck all" button works and syncs across tabs
6. Stopping and restarting the server preserves checkbox state

- [ ] **Step 6: Commit any fixes**

If any issues were found and fixed during smoke testing, commit them:

```bash
git add -A && git commit -m "fix: address issues found during checkbox integration testing"
```
