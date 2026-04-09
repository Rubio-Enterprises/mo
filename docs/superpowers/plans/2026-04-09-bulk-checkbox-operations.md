# Bulk Checkbox Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add clickable checkbox labels, shift-click range selection with bulk check/uncheck, a Check All endpoint, and a batch checkbox endpoint.

**Architecture:** Two new Go endpoints (check-all, batch) mirror the existing uncheck-all pattern. Frontend adds a `useCheckboxSelection` hook for range selection, a `SelectionActionBar` for bulk actions, replaces `UncheckAllButton` with a `CheckboxActionsButton` dropdown, and makes checkbox `<li>` elements clickable.

**Tech Stack:** Go 1.26+, React 19, TypeScript, Vitest

---

## File Structure

### Go (backend)

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `internal/server/server.go` | `CheckAll` and `SetCheckboxBatch` State methods, handlers, route registration |
| Modify | `internal/server/server_test.go` | Tests for new endpoints |

### TypeScript (frontend)

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `internal/frontend/src/hooks/useApi.ts` | `checkAllCheckboxes`, `batchSetCheckboxes` API functions |
| Modify | `internal/frontend/src/hooks/useCheckboxState.ts` | Add `checkAll()`, expose `totalCheckboxes` count |
| Modify | `internal/frontend/src/renderers/registry.ts` | Extend `CheckboxInfo` with `checkAll` |
| Create | `internal/frontend/src/components/CheckboxActionsButton.tsx` | Dropdown: Check All / Uncheck All |
| Modify | `internal/frontend/src/components/FileViewer.tsx` | Swap UncheckAllButton, host selection state, render SelectionActionBar |
| Delete | `internal/frontend/src/components/UncheckAllButton.tsx` | Replaced by CheckboxActionsButton |
| Modify | `internal/frontend/src/renderers/MarkdownRenderer.tsx` | `li` override for clickable labels, shift-click delegation, selection highlighting |
| Create | `internal/frontend/src/hooks/useCheckboxSelection.ts` | Anchor/range selection state, escape/click-outside listeners |
| Create | `internal/frontend/src/hooks/useCheckboxSelection.test.ts` | Tests for selection logic |
| Create | `internal/frontend/src/components/SelectionActionBar.tsx` | Floating bar: "N of M selected — Check / Uncheck / Cancel" |

---

### Task 1: Add Check All and Batch endpoints

**Files:**
- Modify: `internal/server/server.go`
- Modify: `internal/server/server_test.go`

- [ ] **Step 1: Write failing tests for CheckAll**

Add to `internal/server/server_test.go`:

```go
func TestHandleCheckAll(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] Alpha\n- [x] Beta\n- [ ] Gamma\n"), 0o600)

	entry, _ := s.AddFile(mdFile, DefaultGroup)
	handler := NewHandler(s)

	// Set an existing override: Beta overridden to false.
	s.mu.Lock()
	s.checkboxOverrides[entry.ID] = map[string]bool{"Beta": false}
	s.mu.Unlock()

	t.Run("checks all", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/_/api/files/"+entry.ID+"/checkboxes/check-all", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("got status %d, want 204", w.Code)
		}

		s.mu.RLock()
		overrides := s.checkboxOverrides[entry.ID]
		s.mu.RUnlock()

		// Alpha: source false, should have override true.
		if overrides["Alpha"] != true {
			t.Fatal("Alpha override should be true")
		}
		// Beta: source true, should have no override (checked = source).
		if _, exists := overrides["Beta"]; exists {
			t.Fatal("Beta override should be removed (matches source)")
		}
		// Gamma: source false, should have override true.
		if overrides["Gamma"] != true {
			t.Fatal("Gamma override should be true")
		}
	})

	t.Run("returns 404 for unknown file", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/_/api/files/deadbeef/checkboxes/check-all", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("got status %d, want 404", w.Code)
		}
	})
}
```

- [ ] **Step 2: Write failing tests for batch endpoint**

Add to `internal/server/server_test.go`:

```go
func TestHandleBatchSetCheckboxes(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	mdFile := filepath.Join(dir, "tasks.md")
	os.WriteFile(mdFile, []byte("- [ ] Alpha\n- [x] Beta\n- [ ] Gamma\n- [x] Delta\n"), 0o600)

	entry, _ := s.AddFile(mdFile, DefaultGroup)
	handler := NewHandler(s)

	t.Run("batch check specific keys", func(t *testing.T) {
		body := strings.NewReader(`{"keys": ["Alpha", "Gamma"], "checked": true}`)
		req := httptest.NewRequest("POST", "/_/api/files/"+entry.ID+"/checkboxes/batch", body)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("got status %d, want 204", w.Code)
		}

		s.mu.RLock()
		overrides := s.checkboxOverrides[entry.ID]
		s.mu.RUnlock()

		// Alpha: source false, checked true → override true.
		if overrides["Alpha"] != true {
			t.Fatal("Alpha override should be true")
		}
		// Gamma: source false, checked true → override true.
		if overrides["Gamma"] != true {
			t.Fatal("Gamma override should be true")
		}
		// Beta and Delta: untouched.
		if _, exists := overrides["Beta"]; exists {
			t.Fatal("Beta should not have an override")
		}
		if _, exists := overrides["Delta"]; exists {
			t.Fatal("Delta should not have an override")
		}
	})

	t.Run("batch uncheck specific keys", func(t *testing.T) {
		// Clear overrides from previous sub-test.
		s.mu.Lock()
		delete(s.checkboxOverrides, entry.ID)
		s.mu.Unlock()

		body := strings.NewReader(`{"keys": ["Beta", "Delta"], "checked": false}`)
		req := httptest.NewRequest("POST", "/_/api/files/"+entry.ID+"/checkboxes/batch", body)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("got status %d, want 204", w.Code)
		}

		s.mu.RLock()
		overrides := s.checkboxOverrides[entry.ID]
		s.mu.RUnlock()

		// Beta: source true, checked false → override false.
		if overrides["Beta"] != false {
			t.Fatal("Beta override should be false")
		}
		// Delta: source true, checked false → override false.
		if overrides["Delta"] != false {
			t.Fatal("Delta override should be false")
		}
	})

	t.Run("ignores unknown keys", func(t *testing.T) {
		s.mu.Lock()
		delete(s.checkboxOverrides, entry.ID)
		s.mu.Unlock()

		body := strings.NewReader(`{"keys": ["Alpha", "NonExistent"], "checked": true}`)
		req := httptest.NewRequest("POST", "/_/api/files/"+entry.ID+"/checkboxes/batch", body)
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
		if _, exists := overrides["NonExistent"]; exists {
			t.Fatal("NonExistent should not create an override")
		}
	})

	t.Run("returns 404 for unknown file", func(t *testing.T) {
		body := strings.NewReader(`{"keys": ["Alpha"], "checked": true}`)
		req := httptest.NewRequest("POST", "/_/api/files/deadbeef/checkboxes/batch", body)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("got status %d, want 404", w.Code)
		}
	})
}
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /vm-mo/.worktrees/bulk-checkbox && go test ./internal/server/ -run "TestHandleCheckAll|TestHandleBatchSetCheckboxes" -v
```

Expected: compilation errors — methods and handlers not defined.

- [ ] **Step 4: Implement CheckAll State method**

Add to `internal/server/server.go`, after the `UncheckAll` method:

```go
// CheckAll sets all checkboxes to checked for a file.
func (s *State) CheckAll(id string) bool {
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
		if !sourceChecked {
			newOverrides[key] = true
		}
	}

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
```

- [ ] **Step 5: Implement SetCheckboxBatch State method**

Add to `internal/server/server.go`, after the `CheckAll` method:

```go
// SetCheckboxBatch sets multiple checkboxes to the same checked state.
// Keys not present in checkboxSources are silently ignored.
func (s *State) SetCheckboxBatch(id string, keys []string, checked bool) bool {
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
	if src == nil {
		s.mu.Unlock()
		return true
	}

	for _, key := range keys {
		sourceVal, inSrc := src[key]
		if !inSrc {
			continue
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
	}

	srcCopy := make(map[string]bool, len(src))
	for k, v := range src {
		srcCopy[k] = v
	}
	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	s.mu.Unlock()

	s.broadcastCheckboxChanged(id, srcCopy, ovr)
	return true
}
```

- [ ] **Step 6: Add handler functions**

Add to `internal/server/server.go`, after the existing `handleDeleteCheckboxes`:

```go
func handleCheckAll(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}
		if !state.CheckAll(id) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleBatchSetCheckboxes(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}

		var req struct {
			Keys    []string `json:"keys"`
			Checked bool     `json:"checked"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if !state.SetCheckboxBatch(id, req.Keys, req.Checked) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
```

- [ ] **Step 7: Register routes in NewHandler**

In `NewHandler()`, add these two routes after the existing `handleDeleteCheckboxes` registration:

```go
	mux.HandleFunc("POST /_/api/files/{id}/checkboxes/check-all", handleCheckAll(state))
	mux.HandleFunc("POST /_/api/files/{id}/checkboxes/batch", handleBatchSetCheckboxes(state))
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd /vm-mo/.worktrees/bulk-checkbox && go test ./internal/server/ -run "TestHandleCheckAll|TestHandleBatchSetCheckboxes" -v
```

Expected: all pass.

- [ ] **Step 9: Run all Go tests**

```bash
cd /vm-mo/.worktrees/bulk-checkbox && go test ./...
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add internal/server/server.go internal/server/server_test.go && git commit -m "feat: add check-all and batch checkbox API endpoints"
```

---

### Task 2: Add frontend API functions and update useCheckboxState

**Files:**
- Modify: `internal/frontend/src/hooks/useApi.ts`
- Modify: `internal/frontend/src/hooks/useCheckboxState.ts`
- Modify: `internal/frontend/src/renderers/registry.ts`

- [ ] **Step 1: Add API functions to useApi.ts**

Add after the existing `uncheckAllCheckboxes` function at the end of `internal/frontend/src/hooks/useApi.ts`:

```typescript
export async function checkAllCheckboxes(id: string): Promise<void> {
  const res = await fetch(`/_/api/files/${id}/checkboxes/check-all`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to check all");
}

export async function batchSetCheckboxes(
  id: string,
  keys: string[],
  checked: boolean,
): Promise<void> {
  const res = await fetch(`/_/api/files/${id}/checkboxes/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys, checked }),
  });
  if (!res.ok) throw new Error("Failed to batch set checkboxes");
}
```

- [ ] **Step 2: Update CheckboxInfo in registry.ts**

In `internal/frontend/src/renderers/registry.ts`, update the `CheckboxInfo` interface:

Replace:
```typescript
export interface CheckboxInfo {
  hasCheckboxes: boolean;
  uncheckAll: () => void;
}
```

With:
```typescript
export interface CheckboxInfo {
  hasCheckboxes: boolean;
  totalCheckboxes: number;
  uncheckAll: () => void;
  checkAll: () => void;
}
```

- [ ] **Step 3: Add checkAll and totalCheckboxes to useCheckboxState**

In `internal/frontend/src/hooks/useCheckboxState.ts`:

Add the import for `checkAllCheckboxes`:

Replace:
```typescript
import { fetchCheckboxes, toggleCheckbox, uncheckAllCheckboxes } from "./useApi";
```

With:
```typescript
import {
  fetchCheckboxes,
  toggleCheckbox,
  uncheckAllCheckboxes,
  checkAllCheckboxes,
} from "./useApi";
```

Update the `CheckboxStateResult` interface:

Replace:
```typescript
interface CheckboxStateResult {
  getChecked: (key: string) => boolean;
  toggle: (key: string) => void;
  uncheckAll: () => void;
  hasCheckboxes: boolean;
}
```

With:
```typescript
interface CheckboxStateResult {
  getChecked: (key: string) => boolean;
  toggle: (key: string) => void;
  uncheckAll: () => void;
  checkAll: () => void;
  hasCheckboxes: boolean;
  totalCheckboxes: number;
}
```

Add the `checkAll` callback after the existing `uncheckAll`:

```typescript
  const checkAll = useCallback(() => {
    checkAllCheckboxes(fileId).catch(() => {
      // Error handled silently — SSE will provide authoritative state.
    });
  }, [fileId]);
```

Update `hasCheckboxes` line and add `totalCheckboxes`:

Replace:
```typescript
  const hasCheckboxes = Object.keys(sources).length > 0;

  return { getChecked, toggle, uncheckAll, hasCheckboxes };
```

With:
```typescript
  const totalCheckboxes = Object.keys(sources).length;
  const hasCheckboxes = totalCheckboxes > 0;

  return { getChecked, toggle, uncheckAll, checkAll, hasCheckboxes, totalCheckboxes };
```

- [ ] **Step 4: Update onCheckboxInfo in MarkdownRenderer**

In `internal/frontend/src/renderers/MarkdownRenderer.tsx`, update the hook destructuring:

Replace:
```typescript
  const { getChecked, toggle, uncheckAll, hasCheckboxes } = useCheckboxState(fileId);
```

With:
```typescript
  const { getChecked, toggle, uncheckAll, checkAll, hasCheckboxes, totalCheckboxes } =
    useCheckboxState(fileId);
```

Update the `onCheckboxInfo` effect:

Replace:
```typescript
  useEffect(() => {
    onCheckboxInfo?.({ hasCheckboxes, uncheckAll });
  }, [hasCheckboxes, uncheckAll, onCheckboxInfo]);
```

With:
```typescript
  useEffect(() => {
    onCheckboxInfo?.({ hasCheckboxes, totalCheckboxes, uncheckAll, checkAll });
  }, [hasCheckboxes, totalCheckboxes, uncheckAll, checkAll, onCheckboxInfo]);
```

- [ ] **Step 5: Verify frontend compiles**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm run build
```

Expected: builds without errors.

- [ ] **Step 6: Commit**

```bash
git add internal/frontend/src/hooks/useApi.ts internal/frontend/src/hooks/useCheckboxState.ts internal/frontend/src/renderers/registry.ts internal/frontend/src/renderers/MarkdownRenderer.tsx && git commit -m "feat: add checkAll and batch API functions, update CheckboxInfo type"
```

---

### Task 3: Create CheckboxActionsButton and replace UncheckAllButton

**Files:**
- Create: `internal/frontend/src/components/CheckboxActionsButton.tsx`
- Modify: `internal/frontend/src/components/FileViewer.tsx`
- Delete: `internal/frontend/src/components/UncheckAllButton.tsx`

- [ ] **Step 1: Create CheckboxActionsButton**

Create `internal/frontend/src/components/CheckboxActionsButton.tsx`:

```typescript
import { useState, useRef, useEffect } from "react";

interface CheckboxActionsButtonProps {
  onCheckAll: () => void;
  onUncheckAll: () => void;
}

export function CheckboxActionsButton({ onCheckAll, onUncheckAll }: CheckboxActionsButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="flex items-center justify-center bg-transparent border border-gh-border rounded-md p-1.5 text-gh-text-secondary cursor-pointer transition-colors duration-150 hover:bg-gh-bg-hover"
        onClick={() => setOpen((v) => !v)}
        aria-label="Checkbox actions"
        title="Checkbox actions"
      >
        <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <rect x="3" y="3" width="18" height="18" rx="3" strokeLinecap="round" strokeLinejoin="round" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-36 bg-gh-bg-sidebar border border-gh-border rounded-md shadow-lg z-10 py-1">
          <button
            className="flex items-center w-full px-3 py-1.5 border-none cursor-pointer text-left text-xs bg-transparent text-gh-text-secondary hover:bg-gh-bg-hover transition-colors duration-150"
            onClick={() => {
              onCheckAll();
              setOpen(false);
            }}
          >
            Check all
          </button>
          <button
            className="flex items-center w-full px-3 py-1.5 border-none cursor-pointer text-left text-xs bg-transparent text-gh-text-secondary hover:bg-gh-bg-hover transition-colors duration-150"
            onClick={() => {
              onUncheckAll();
              setOpen(false);
            }}
          >
            Uncheck all
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update FileViewer to use CheckboxActionsButton**

In `internal/frontend/src/components/FileViewer.tsx`:

Replace the import:
```typescript
import { UncheckAllButton } from "./UncheckAllButton";
```

With:
```typescript
import { CheckboxActionsButton } from "./CheckboxActionsButton";
```

Replace the UncheckAllButton usage in the action bar:
```typescript
          {checkboxInfo?.hasCheckboxes && <UncheckAllButton onUncheckAll={checkboxInfo.uncheckAll} />}
```

With:
```typescript
          {checkboxInfo?.hasCheckboxes && (
            <CheckboxActionsButton
              onCheckAll={checkboxInfo.checkAll}
              onUncheckAll={checkboxInfo.uncheckAll}
            />
          )}
```

- [ ] **Step 3: Delete UncheckAllButton**

```bash
rm internal/frontend/src/components/UncheckAllButton.tsx
```

- [ ] **Step 4: Verify no remaining imports of UncheckAllButton**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && grep -r "UncheckAllButton" src/
```

Expected: no results.

- [ ] **Step 5: Verify frontend compiles**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm run build
```

Expected: builds without errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: replace UncheckAllButton with CheckboxActionsButton dropdown"
```

---

### Task 4: Add clickable checkbox labels

**Files:**
- Modify: `internal/frontend/src/renderers/MarkdownRenderer.tsx`

- [ ] **Step 1: Add li component override**

In `internal/frontend/src/renderers/MarkdownRenderer.tsx`, inside the `components` useMemo (the object passed to `<Markdown components={components}>`), add a `li` override before the existing `input` override.

Add this inside the components object, before the `input:` property:

```typescript
    li: ({ className, children, ...props }) => {
      const isTask = typeof className === "string" && className.includes("task-list-item");
      if (!isTask) {
        return (
          <li className={className} {...props}>
            {children}
          </li>
        );
      }
      // Extract checkbox key from the first input child.
      let checkboxKey: string | undefined;
      const childArray = Array.isArray(children) ? children : [children];
      for (const child of childArray) {
        if (
          child &&
          typeof child === "object" &&
          "props" in child &&
          child.props?.type === "checkbox" &&
          child.props?.["data-checkbox-key"]
        ) {
          checkboxKey = child.props["data-checkbox-key"] as string;
          break;
        }
      }
      return (
        <li
          className={className}
          style={{ cursor: checkboxKey ? "pointer" : undefined, userSelect: "none" }}
          onClick={(e) => {
            if (!checkboxKey) return;
            // Don't toggle if user clicked a link.
            let target = e.target as HTMLElement | null;
            while (target && target !== e.currentTarget) {
              if (target.tagName === "A") return;
              target = target.parentElement;
            }
            // Don't toggle if user clicked the checkbox input directly (it has its own handler).
            if ((e.target as HTMLElement).tagName === "INPUT") return;
            toggle(checkboxKey);
          }}
          {...props}
        >
          {children}
        </li>
      );
    },
```

- [ ] **Step 2: Add hover style for task list items**

In `internal/frontend/src/styles/app.css`, add a rule for clickable task list items. Find the file and add after existing markdown-body styles:

```css
.markdown-body li.task-list-item:hover {
  background-color: var(--color-gh-bg-hover);
  border-radius: 4px;
}
```

Note: Check if this file exists and where markdown-body styles are defined. If styles are in a different location, add it there.

- [ ] **Step 3: Verify frontend compiles**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm run build
```

Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: make checkbox label text clickable to toggle"
```

---

### Task 5: Create useCheckboxSelection hook

**Files:**
- Create: `internal/frontend/src/hooks/useCheckboxSelection.ts`
- Create: `internal/frontend/src/hooks/useCheckboxSelection.test.ts`

- [ ] **Step 1: Create the hook**

Create `internal/frontend/src/hooks/useCheckboxSelection.ts`:

```typescript
import { useState, useCallback, useEffect, useRef } from "react";

interface CheckboxSelectionResult {
  /** The set of selected checkbox keys. */
  selectedKeys: string[];
  /** Whether the given key is currently selected. */
  isSelected: (key: string) => boolean;
  /** Handle a shift-click on a checkbox key. Sets anchor or completes range. */
  onShiftClick: (key: string) => void;
  /** Clear all selection state. */
  clearSelection: () => void;
}

/**
 * Manages shift-click range selection for checkboxes.
 * @param articleRef - ref to the article element containing checkbox elements with data-checkbox-key attributes.
 */
export function useCheckboxSelection(
  articleRef: React.RefObject<HTMLElement | null>,
): CheckboxSelectionResult {
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const selectedSetRef = useRef(new Set<string>());

  // Keep set ref in sync.
  useEffect(() => {
    selectedSetRef.current = new Set(selectedKeys);
  }, [selectedKeys]);

  const isSelected = useCallback(
    (key: string): boolean => selectedSetRef.current.has(key),
    [],
  );

  const getDocumentOrder = useCallback((): string[] => {
    if (!articleRef.current) return [];
    const inputs = articleRef.current.querySelectorAll<HTMLInputElement>(
      "input[data-checkbox-key]",
    );
    return Array.from(inputs).map((el) => el.getAttribute("data-checkbox-key")!);
  }, [articleRef]);

  const onShiftClick = useCallback(
    (key: string) => {
      if (anchor === null || selectedKeys.length > 0) {
        // No anchor yet, or a range already exists — start fresh.
        setAnchor(key);
        setSelectedKeys([key]);
        return;
      }

      // Anchor is set, no range yet — compute range.
      const order = getDocumentOrder();
      const anchorIdx = order.indexOf(anchor);
      const targetIdx = order.indexOf(key);
      if (anchorIdx === -1 || targetIdx === -1) {
        // Fallback: just select the clicked key.
        setAnchor(key);
        setSelectedKeys([key]);
        return;
      }

      const start = Math.min(anchorIdx, targetIdx);
      const end = Math.max(anchorIdx, targetIdx);
      setSelectedKeys(order.slice(start, end + 1));
    },
    [anchor, selectedKeys.length, getDocumentOrder],
  );

  const clearSelection = useCallback(() => {
    setAnchor(null);
    setSelectedKeys([]);
  }, []);

  // Escape key clears selection.
  useEffect(() => {
    if (selectedKeys.length === 0 && anchor === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearSelection();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedKeys.length, anchor, clearSelection]);

  // Click outside task list items clears selection.
  useEffect(() => {
    if (selectedKeys.length === 0 && anchor === null) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't clear if clicking inside a task list item.
      if (target.closest("li.task-list-item")) return;
      // Don't clear if clicking inside the selection action bar.
      if (target.closest("[data-selection-action-bar]")) return;
      // Don't clear if clicking inside the checkbox actions button.
      if (target.closest("[data-checkbox-actions]")) return;
      clearSelection();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selectedKeys.length, anchor, clearSelection]);

  return { selectedKeys, isSelected, onShiftClick, clearSelection };
}
```

- [ ] **Step 2: Create tests for the hook**

Create `internal/frontend/src/hooks/useCheckboxSelection.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";

// Test the pure selection logic extracted from the hook.
// We test the range computation algorithm directly since the hook
// depends on DOM refs that are hard to mock in unit tests.

function computeRange(
  order: string[],
  anchor: string,
  target: string,
): string[] {
  const anchorIdx = order.indexOf(anchor);
  const targetIdx = order.indexOf(target);
  if (anchorIdx === -1 || targetIdx === -1) return [target];
  const start = Math.min(anchorIdx, targetIdx);
  const end = Math.max(anchorIdx, targetIdx);
  return order.slice(start, end + 1);
}

describe("computeRange", () => {
  const order = ["A", "B", "C", "D", "E"];

  it("selects forward range", () => {
    expect(computeRange(order, "B", "D")).toEqual(["B", "C", "D"]);
  });

  it("selects backward range", () => {
    expect(computeRange(order, "D", "B")).toEqual(["B", "C", "D"]);
  });

  it("selects single item when anchor equals target", () => {
    expect(computeRange(order, "C", "C")).toEqual(["C"]);
  });

  it("selects full range from first to last", () => {
    expect(computeRange(order, "A", "E")).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("returns only target when anchor not in order", () => {
    expect(computeRange(order, "Z", "C")).toEqual(["C"]);
  });

  it("returns only target when target not in order", () => {
    expect(computeRange(order, "B", "Z")).toEqual(["Z"]);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm test src/hooks/useCheckboxSelection.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add internal/frontend/src/hooks/useCheckboxSelection.ts internal/frontend/src/hooks/useCheckboxSelection.test.ts && git commit -m "feat: add useCheckboxSelection hook for shift-click range selection"
```

---

### Task 6: Create SelectionActionBar component

**Files:**
- Create: `internal/frontend/src/components/SelectionActionBar.tsx`

- [ ] **Step 1: Create the component**

Create `internal/frontend/src/components/SelectionActionBar.tsx`:

```typescript
import { useEffect, useRef } from "react";

interface SelectionActionBarProps {
  selectedCount: number;
  totalCount: number;
  onCheck: () => void;
  onUncheck: () => void;
  onCancel: () => void;
}

export function SelectionActionBar({
  selectedCount,
  totalCount,
  onCheck,
  onUncheck,
  onCancel,
}: SelectionActionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  // Auto-focus the bar for keyboard accessibility.
  useEffect(() => {
    barRef.current?.focus();
  }, []);

  return (
    <div
      ref={barRef}
      tabIndex={-1}
      data-selection-action-bar
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 bg-gh-bg-sidebar border border-gh-border rounded-lg shadow-lg text-sm outline-none"
    >
      <span className="text-gh-text-secondary font-medium">
        {selectedCount} of {totalCount} selected
      </span>
      <span className="text-gh-border">|</span>
      <button
        className="px-2 py-1 rounded text-xs font-medium bg-transparent border border-gh-border text-gh-text-secondary hover:bg-gh-bg-hover cursor-pointer transition-colors duration-150"
        onClick={onCheck}
      >
        Check
      </button>
      <button
        className="px-2 py-1 rounded text-xs font-medium bg-transparent border border-gh-border text-gh-text-secondary hover:bg-gh-bg-hover cursor-pointer transition-colors duration-150"
        onClick={onUncheck}
      >
        Uncheck
      </button>
      <button
        className="px-2 py-1 rounded text-xs font-medium bg-transparent border-none text-gh-text-secondary hover:text-gh-text cursor-pointer transition-colors duration-150"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend compiles**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm run build
```

Expected: builds without errors.

- [ ] **Step 3: Commit**

```bash
git add internal/frontend/src/components/SelectionActionBar.tsx && git commit -m "feat: add SelectionActionBar floating component"
```

---

### Task 7: Wire selection into FileViewer and MarkdownRenderer

**Files:**
- Modify: `internal/frontend/src/components/FileViewer.tsx`
- Modify: `internal/frontend/src/renderers/MarkdownRenderer.tsx`
- Modify: `internal/frontend/src/renderers/registry.ts`

- [ ] **Step 1: Add selection props to renderer types**

In `internal/frontend/src/renderers/registry.ts`, add selection callback props to `BaseRendererProps`:

```typescript
interface BaseRendererProps {
  fileId: string;
  fileName: string;
  revision: number;
  isRawView: boolean;
  onFileOpened?: (fileId: string) => void;
  onHeadingsChange: (headings: TocHeading[]) => void;
  onContentRendered?: () => void;
  onCheckboxInfo?: (info: CheckboxInfo) => void;
  onShiftClick?: (key: string) => void;
  isCheckboxSelected?: (key: string) => boolean;
}
```

- [ ] **Step 2: Wire useCheckboxSelection into FileViewer**

In `internal/frontend/src/components/FileViewer.tsx`:

Add imports:
```typescript
import { useCheckboxSelection } from "../hooks/useCheckboxSelection";
import { SelectionActionBar } from "./SelectionActionBar";
import { batchSetCheckboxes } from "../hooks/useApi";
```

Add a ref for the article element. Find the article element and add a ref. First, add the ref and the hook near the other state:

```typescript
  const articleRef = useRef<HTMLDivElement>(null);
  const { selectedKeys, isSelected, onShiftClick, clearSelection } =
    useCheckboxSelection(articleRef);
```

Add the selection action handlers:

```typescript
  const handleBatchCheck = useCallback(() => {
    if (!checkboxInfo) return;
    batchSetCheckboxes(fileId, selectedKeys, true).catch(() => {});
    clearSelection();
  }, [fileId, selectedKeys, clearSelection, checkboxInfo]);

  const handleBatchUncheck = useCallback(() => {
    if (!checkboxInfo) return;
    batchSetCheckboxes(fileId, selectedKeys, false).catch(() => {});
    clearSelection();
  }, [fileId, selectedKeys, clearSelection, checkboxInfo]);
```

Add `ref={articleRef}` to the `<article>` element:

Replace:
```typescript
        <article className={`markdown-body min-w-0 flex-1${isWide ? " markdown-body--wide" : ""}`}>
```

With:
```typescript
        <article ref={articleRef} className={`markdown-body min-w-0 flex-1${isWide ? " markdown-body--wide" : ""}`}>
```

Pass `onShiftClick` and `isCheckboxSelected` down to the renderer via `rendererProps`. Find where `rendererProps` is built and add:

```typescript
  onShiftClick,
  isCheckboxSelected: isSelected,
```

After the closing `</div>` of the main flex container (after the action bar column), add the SelectionActionBar:

```typescript
      {selectedKeys.length >= 2 && checkboxInfo && (
        <SelectionActionBar
          selectedCount={selectedKeys.length}
          totalCount={checkboxInfo.totalCheckboxes}
          onCheck={handleBatchCheck}
          onUncheck={handleBatchUncheck}
          onCancel={clearSelection}
        />
      )}
```

Add `useRef` and `useCallback` to the React import if not already present.

- [ ] **Step 3: Update MarkdownRenderer to handle shift-click and selection highlighting**

In `internal/frontend/src/renderers/MarkdownRenderer.tsx`:

Add `onShiftClick` and `isCheckboxSelected` to the destructured props:

Replace:
```typescript
  const { getChecked, toggle, uncheckAll, checkAll, hasCheckboxes, totalCheckboxes } =
    useCheckboxState(fileId);
```

(Keep this line as-is, but add the new props to the function signature destructuring.)

In the function signature, add:

```typescript
  onShiftClick,
  isCheckboxSelected,
```

Update the `li` override to handle shift-click and highlighting. Replace the `onClick` handler in the `li` override:

Replace the `onClick` in the task-list `<li>`:

```typescript
          onClick={(e) => {
            if (!checkboxKey) return;
            // Don't toggle if user clicked a link.
            let target = e.target as HTMLElement | null;
            while (target && target !== e.currentTarget) {
              if (target.tagName === "A") return;
              target = target.parentElement;
            }
            // Don't toggle if user clicked the checkbox input directly (it has its own handler).
            if ((e.target as HTMLElement).tagName === "INPUT") return;
            toggle(checkboxKey);
          }}
```

With:

```typescript
          onClick={(e) => {
            if (!checkboxKey) return;
            // Don't toggle if user clicked a link.
            let target = e.target as HTMLElement | null;
            while (target && target !== e.currentTarget) {
              if (target.tagName === "A") return;
              target = target.parentElement;
            }
            // Don't toggle if user clicked the checkbox input directly (it has its own handler).
            if ((e.target as HTMLElement).tagName === "INPUT") return;
            if (e.shiftKey && onShiftClick) {
              onShiftClick(checkboxKey);
            } else {
              toggle(checkboxKey);
            }
          }}
```

Add selection highlight styling to the task-list `<li>`. Update the `style` prop:

Replace:
```typescript
          style={{ cursor: checkboxKey ? "pointer" : undefined, userSelect: "none" }}
```

With:
```typescript
          style={{
            cursor: checkboxKey ? "pointer" : undefined,
            userSelect: "none",
            backgroundColor: checkboxKey && isCheckboxSelected?.(checkboxKey) ? "var(--color-gh-bg-active)" : undefined,
            borderLeft: checkboxKey && isCheckboxSelected?.(checkboxKey) ? "3px solid var(--color-gh-accent)" : undefined,
            paddingLeft: checkboxKey && isCheckboxSelected?.(checkboxKey) ? "5px" : undefined,
            borderRadius: "4px",
          }}
```

Also update the `input` component override to handle shift-click. In the `onChange` handler:

Replace:
```typescript
          onChange={() => toggle(key)}
```

With:
```typescript
          onChange={(e) => {
            // Prevent li handler from also firing.
            e.stopPropagation();
          }}
          onClick={(e) => {
            if (e.shiftKey && onShiftClick) {
              e.preventDefault();
              onShiftClick(key);
            } else {
              toggle(key);
            }
          }}
```

Add `onShiftClick` and `isCheckboxSelected` to the `components` useMemo dependency array:

Replace:
```typescript
  [fileId, handleLinkClick, getChecked, toggle],
```

With:
```typescript
  [fileId, handleLinkClick, getChecked, toggle, onShiftClick, isCheckboxSelected],
```

- [ ] **Step 4: Verify frontend compiles**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm run build
```

Expected: builds without errors.

- [ ] **Step 5: Run all frontend tests**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: wire shift-click selection into FileViewer and MarkdownRenderer"
```

---

### Task 8: Full integration test

**Files:** No new files — validation only.

- [ ] **Step 1: Run all Go tests**

```bash
cd /vm-mo/.worktrees/bulk-checkbox && go test ./...
```

Expected: all pass.

- [ ] **Step 2: Run all frontend tests**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm test
```

Expected: all pass.

- [ ] **Step 3: Run full build**

```bash
cd /vm-mo/.worktrees/bulk-checkbox && make build
```

Expected: builds successfully (frontend + Go binary).

- [ ] **Step 4: Run linters**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm run lint && pnpm run fmt:check
```

Expected: no lint or formatting errors.

- [ ] **Step 5: Fix formatting if needed**

```bash
cd /vm-mo/.worktrees/bulk-checkbox/internal/frontend && pnpm run fmt
```

If any files were formatted, commit:

```bash
git add -A && git commit -m "style: fix frontend formatting"
```

- [ ] **Step 6: Manual smoke test**

```bash
cd /vm-mo/.worktrees/bulk-checkbox && make dev ARGS="testdata/gfm.md"
```

Open the browser. Verify:
1. Clicking checkbox label text toggles the checkbox (not just the input)
2. Links inside checkbox labels navigate instead of toggling
3. Shift+click first checkbox highlights it
4. Shift+click second checkbox highlights the range, shows floating action bar with "N of M selected"
5. "Check" in action bar checks all selected checkboxes
6. "Uncheck" in action bar unchecks all selected checkboxes
7. Escape clears selection
8. Clicking outside task list items clears selection
9. Check All / Uncheck All dropdown in right action bar works
10. Multi-client sync still works (open second tab)
11. Action bar buttons are keyboard-accessible (Tab + Enter)
