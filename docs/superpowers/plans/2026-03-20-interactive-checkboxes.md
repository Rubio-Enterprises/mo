# Interactive Checkboxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GFM task list checkboxes interactive in the browser, with state persisted in localStorage as an overlay on source state.

**Architecture:** A custom rehype plugin annotates checkbox `<input>` elements with `data-checkbox-key` attributes derived from their label text. A React hook manages localStorage-backed overrides keyed by filename. A custom `input` component in react-markdown reads the key and consults the hook to determine checked state and handle clicks.

**Tech Stack:** TypeScript, React 19, react-markdown, rehype (unified/hast), vitest, localStorage

**Spec:** `docs/superpowers/specs/2026-03-20-interactive-checkboxes-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `internal/frontend/src/plugins/rehypeCheckboxKeys.ts` | Rehype plugin: walks HAST, extracts checkbox labels, adds `data-checkbox-key` attributes, reports checkbox map via callback |
| `internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts` | Tests for the rehype plugin |
| `internal/frontend/src/hooks/useCheckboxOverrides.ts` | React hook: localStorage persistence, reconciliation, getChecked/toggle API |
| `internal/frontend/src/hooks/useCheckboxOverrides.test.ts` | Tests for the hook |

### Modified Files

| File | Changes |
|------|---------|
| `internal/frontend/src/components/MarkdownViewer.tsx` | Import plugin + hook, update sanitize schema, add plugin to rehype pipeline, register custom `input` component |

---

## Task 0: Install Dependencies

**Files:**

- Modify: `internal/frontend/package.json`

The rehype plugin needs `unist-util-visit` (for HAST tree walking) and `@types/hast` (for TypeScript types). The plugin integration tests need `remark-parse`, `remark-rehype`, and `rehype-stringify` to run a full markdown-to-HTML pipeline. These are all transitive dependencies of the rehype ecosystem but must be direct dependencies with pnpm's strict resolution.

- [ ] **Step 1: Install runtime and dev dependencies**

```bash
cd internal/frontend && pnpm add unist-util-visit && pnpm add -D @types/hast remark-parse remark-rehype rehype-stringify
```

- [ ] **Step 2: Verify imports resolve**

```bash
cd internal/frontend && node -e "require('unist-util-visit'); require('rehype-stringify'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add internal/frontend/package.json internal/frontend/pnpm-lock.yaml
git commit -m "build: add rehype plugin dependencies"
```

---

## Task 1: HAST Text Extraction Utility

**Files:**

- Create: `internal/frontend/src/plugins/rehypeCheckboxKeys.ts` (just the `extractHastText` helper initially)
- Test: `internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts`

This utility recursively extracts plain text from HAST nodes, analogous to the existing `extractText.ts` utility which does the same for React nodes.

- [ ] **Step 1: Write failing tests for HAST text extraction**

```typescript
// internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts
import { describe, it, expect } from "vitest";
import { extractHastText } from "./rehypeCheckboxKeys";
import type { Element, Text } from "hast";

function text(value: string): Text {
  return { type: "text", value };
}

function el(tagName: string, children: (Element | Text)[]): Element {
  return { type: "element", tagName, properties: {}, children };
}

describe("extractHastText", () => {
  it("extracts text from a text node", () => {
    expect(extractHastText(text("hello"))).toBe("hello");
  });

  it("extracts text from nested elements", () => {
    const node = el("li", [
      text("before "),
      el("strong", [text("bold")]),
      text(" after"),
    ]);
    expect(extractHastText(node)).toBe("before bold after");
  });

  it("extracts text from deeply nested formatting", () => {
    const node = el("li", [
      el("em", [el("strong", [text("deep")])]),
    ]);
    expect(extractHastText(node)).toBe("deep");
  });

  it("returns empty string for element with no text", () => {
    const node = el("li", []);
    expect(extractHastText(node)).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd internal/frontend && pnpm test src/plugins/rehypeCheckboxKeys.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement extractHastText**

```typescript
// internal/frontend/src/plugins/rehypeCheckboxKeys.ts
import type { Node, Element as HastElement, Text as HastText } from "hast";

export function extractHastText(node: Node): string {
  if (node.type === "text") {
    return (node as HastText).value;
  }
  if (node.type === "element") {
    const el = node as HastElement;
    return el.children.map(extractHastText).join("");
  }
  return "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd internal/frontend && pnpm test src/plugins/rehypeCheckboxKeys.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add internal/frontend/src/plugins/rehypeCheckboxKeys.ts internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts
git commit -m "feat: add HAST text extraction utility for checkbox keys"
```

---

## Task 2: Checkbox Key Generation Logic

**Files:**

- Modify: `internal/frontend/src/plugins/rehypeCheckboxKeys.ts` — add `computeCheckboxKey` and key tracking
- Test: `internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts` — add key generation tests

This task adds the logic to derive a checkbox key from a list item's text content, including duplicate disambiguation.

- [ ] **Step 1: Write failing tests for key generation**

Add to the existing test file:

```typescript
import { computeCheckboxKey } from "./rehypeCheckboxKeys";

describe("computeCheckboxKey", () => {
  it("returns trimmed text as key for first occurrence", () => {
    const counts = new Map<string, number>();
    expect(computeCheckboxKey("  Buy milk  ", counts)).toBe("Buy milk");
    expect(counts.get("Buy milk")).toBe(1);
  });

  it("disambiguates duplicate labels with #N suffix", () => {
    const counts = new Map<string, number>();
    expect(computeCheckboxKey("TODO", counts)).toBe("TODO");
    expect(computeCheckboxKey("TODO", counts)).toBe("TODO#2");
    expect(computeCheckboxKey("TODO", counts)).toBe("TODO#3");
  });

  it("uses __empty for empty/whitespace-only labels", () => {
    const counts = new Map<string, number>();
    expect(computeCheckboxKey("", counts)).toBe("__empty");
    expect(computeCheckboxKey("   ", counts)).toBe("__empty#2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd internal/frontend && pnpm test src/plugins/rehypeCheckboxKeys.test.ts`
Expected: FAIL — `computeCheckboxKey` not exported

- [ ] **Step 3: Implement computeCheckboxKey**

Add to `internal/frontend/src/plugins/rehypeCheckboxKeys.ts`:

```typescript
export function computeCheckboxKey(
  rawText: string,
  occurrences: Map<string, number>,
): string {
  const base = rawText.trim() || "__empty";
  const count = (occurrences.get(base) ?? 0) + 1;
  occurrences.set(base, count);
  return count === 1 ? base : `${base}#${count}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd internal/frontend && pnpm test src/plugins/rehypeCheckboxKeys.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add internal/frontend/src/plugins/rehypeCheckboxKeys.ts internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts
git commit -m "feat: add checkbox key generation with duplicate disambiguation"
```

---

## Task 3: Rehype Plugin Core

**Files:**

- Modify: `internal/frontend/src/plugins/rehypeCheckboxKeys.ts` — add the plugin function
- Test: `internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts` — add plugin integration tests

The plugin walks the HAST tree, finds `<input type="checkbox">` elements inside `<li>`, extracts label text from the `<li>`'s first paragraph, assigns `data-checkbox-key`, and calls the `onCheckboxMap` callback with all keys and source states.

- [ ] **Step 1: Write failing tests for the plugin**

These tests run the plugin against a HAST tree and verify the output. Add to the test file:

```typescript
import { rehypeCheckboxKeys } from "./rehypeCheckboxKeys";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";

async function processMarkdown(
  md: string,
  onCheckboxMap?: (map: Map<string, boolean>) => void,
) {
  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeCheckboxKeys, { onCheckboxMap })
    .use(rehypeStringify)
    .process(md);
  return String(result);
}

describe("rehypeCheckboxKeys plugin", () => {
  it("adds data-checkbox-key to checkboxes", async () => {
    const md = "- [ ] First item\n- [x] Second item\n";
    const html = await processMarkdown(md);
    expect(html).toContain('data-checkbox-key="First item"');
    expect(html).toContain('data-checkbox-key="Second item"');
  });

  it("reports checkbox map via callback", async () => {
    let receivedMap: Map<string, boolean> | undefined;
    const md = "- [ ] Unchecked\n- [x] Checked\n";
    await processMarkdown(md, (map) => {
      receivedMap = map;
    });
    expect(receivedMap).toBeDefined();
    expect(receivedMap!.get("Unchecked")).toBe(false);
    expect(receivedMap!.get("Checked")).toBe(true);
  });

  it("handles duplicate labels", async () => {
    const md = "- [ ] TODO\n- [ ] TODO\n- [x] TODO\n";
    const html = await processMarkdown(md);
    expect(html).toContain('data-checkbox-key="TODO"');
    expect(html).toContain('data-checkbox-key="TODO#2"');
    expect(html).toContain('data-checkbox-key="TODO#3"');
  });

  it("strips inline formatting from labels", async () => {
    const md = "- [ ] **bold** and *italic* text\n";
    const html = await processMarkdown(md);
    expect(html).toContain('data-checkbox-key="bold and italic text"');
  });

  it("handles empty checkbox labels", async () => {
    const md = "- [ ] \n- [ ] \n";
    const html = await processMarkdown(md);
    expect(html).toContain('data-checkbox-key="__empty"');
    expect(html).toContain('data-checkbox-key="__empty#2"');
  });

  it("does not modify non-checkbox inputs", async () => {
    const md = 'Some text <input type="text" /> more text\n';
    const html = await processMarkdown(md);
    expect(html).not.toContain("data-checkbox-key");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd internal/frontend && pnpm test src/plugins/rehypeCheckboxKeys.test.ts`
Expected: FAIL — `rehypeCheckboxKeys` not exported or not a function

- [ ] **Step 3: Implement the rehype plugin**

Add to `internal/frontend/src/plugins/rehypeCheckboxKeys.ts`:

```typescript
import { visit } from "unist-util-visit";
import type { Root, Element as HastElement } from "hast";

interface RehypeCheckboxKeysOptions {
  onCheckboxMap?: (map: Map<string, boolean>) => void;
}

export function rehypeCheckboxKeys(options: RehypeCheckboxKeysOptions = {}) {
  return (tree: Root) => {
    const occurrences = new Map<string, number>();
    const checkboxMap = new Map<string, boolean>();

    visit(tree, "element", (node: HastElement, _index, parent) => {
      if (
        node.tagName !== "input" ||
        node.properties?.type !== "checkbox"
      ) {
        return;
      }

      // Extract label text from the parent <li>'s children, excluding the input itself
      // and excluding nested lists (<ul>, <ol>)
      const parentEl = parent as HastElement | null;
      if (!parentEl || parentEl.type !== "element") return;

      let labelText = "";
      for (const child of parentEl.children) {
        if (child === node) continue;
        if (
          child.type === "element" &&
          (child as HastElement).tagName === "ul" ||
          child.type === "element" &&
          (child as HastElement).tagName === "ol"
        ) {
          continue;
        }
        // For <p> children (tight vs loose lists), take only the first <p>
        if (child.type === "element" && (child as HastElement).tagName === "p") {
          const pEl = child as HastElement;
          // Check if this <p> contains the checkbox input (loose list format)
          const hasInput = pEl.children.some(
            (c) =>
              c.type === "element" &&
              (c as HastElement).tagName === "input" &&
              (c as HastElement).properties?.type === "checkbox",
          );
          if (hasInput) {
            // Extract text from this <p> excluding the input
            for (const pChild of pEl.children) {
              if (
                pChild.type === "element" &&
                (pChild as HastElement).tagName === "input"
              ) {
                continue;
              }
              labelText += extractHastText(pChild);
            }
          } else {
            labelText += extractHastText(child);
          }
          break; // Only first paragraph
        }
        labelText += extractHastText(child);
      }

      const key = computeCheckboxKey(labelText, occurrences);
      const isChecked = node.properties?.checked === true;

      node.properties = node.properties || {};
      node.properties["dataCheckboxKey"] = key;
      checkboxMap.set(key, isChecked);
    });

    options.onCheckboxMap?.(checkboxMap);
  };
}
```

Note: Dependencies (`unist-util-visit`, `@types/hast`, `rehype-stringify`, `remark-parse`, `remark-rehype`) are installed in Task 0.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd internal/frontend && pnpm test src/plugins/rehypeCheckboxKeys.test.ts`
Expected: PASS (all tests)

Debugging notes: If the `data-checkbox-key` attribute name in the rendered HTML differs (e.g., `datacheckboxkey`), adjust the property name. In HAST, `dataCheckboxKey` maps to `data-checkbox-key` in HTML output. Verify this in the test output.

- [ ] **Step 5: Commit**

```bash
git add internal/frontend/src/plugins/rehypeCheckboxKeys.ts internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts
git commit -m "feat: implement rehypeCheckboxKeys plugin"
```

---

## Task 4: useCheckboxOverrides Hook

**Files:**

- Create: `internal/frontend/src/hooks/useCheckboxOverrides.ts`
- Create: `internal/frontend/src/hooks/useCheckboxOverrides.test.ts`

The hook manages localStorage persistence and reconciliation. It exposes `getChecked`, `toggle`, and `setCheckboxMap`.

- [ ] **Step 1: Write failing tests for the hook**

```typescript
// internal/frontend/src/hooks/useCheckboxOverrides.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCheckboxOverrides } from "./useCheckboxOverrides";

const STORAGE_KEY = "mo-checkbox-overrides";

beforeEach(() => {
  localStorage.clear();
});

describe("useCheckboxOverrides", () => {
  it("returns source state when no overrides exist", () => {
    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    act(() => {
      result.current.setCheckboxMap(
        new Map([
          ["Item A", false],
          ["Item B", true],
        ]),
      );
    });

    expect(result.current.getChecked("Item A")).toBe(false);
    expect(result.current.getChecked("Item B")).toBe(true);
  });

  it("toggles a checkbox and persists to localStorage", () => {
    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    act(() => {
      result.current.setCheckboxMap(new Map([["Item A", false]]));
    });

    act(() => {
      result.current.toggle("Item A");
    });

    expect(result.current.getChecked("Item A")).toBe(true);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored["test.md"]["Item A"]).toBe(true);
  });

  it("removes override when toggling back to source state", () => {
    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    act(() => {
      result.current.setCheckboxMap(new Map([["Item A", false]]));
    });

    // Toggle on
    act(() => {
      result.current.toggle("Item A");
    });
    expect(result.current.getChecked("Item A")).toBe(true);

    // Toggle off (back to source state)
    act(() => {
      result.current.toggle("Item A");
    });
    expect(result.current.getChecked("Item A")).toBe(false);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored["test.md"]).toBeUndefined();
  });

  it("reconciles overrides when checkbox map changes", () => {
    // Pre-populate localStorage with an override
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "test.md": { "Item A": true, "Deleted": false } }),
    );

    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    // Source now has Item A as checked (matches override) and Deleted is gone
    act(() => {
      result.current.setCheckboxMap(new Map([["Item A", true]]));
    });

    // Item A override should be removed (matches source)
    // Deleted override should be removed (not in source)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored["test.md"]).toBeUndefined();
  });

  it("keeps overrides that differ from source", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "test.md": { "Item A": true } }),
    );

    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    // Source has Item A unchecked — override should remain
    act(() => {
      result.current.setCheckboxMap(new Map([["Item A", false]]));
    });

    expect(result.current.getChecked("Item A")).toBe(true);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored["test.md"]["Item A"]).toBe(true);
  });

  it("isolates state per filename", () => {
    const { result: hook1 } = renderHook(() =>
      useCheckboxOverrides("file1.md"),
    );
    const { result: hook2 } = renderHook(() =>
      useCheckboxOverrides("file2.md"),
    );

    act(() => {
      hook1.current.setCheckboxMap(new Map([["Item", false]]));
      hook2.current.setCheckboxMap(new Map([["Item", false]]));
    });

    act(() => {
      hook1.current.toggle("Item");
    });

    expect(hook1.current.getChecked("Item")).toBe(true);
    expect(hook2.current.getChecked("Item")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd internal/frontend && pnpm test src/hooks/useCheckboxOverrides.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the hook**

```typescript
// internal/frontend/src/hooks/useCheckboxOverrides.ts
import { useState, useCallback, useRef } from "react";

const STORAGE_KEY = "mo-checkbox-overrides";

type AllOverrides = Record<string, Record<string, boolean>>;

function loadOverrides(): AllOverrides {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveOverrides(overrides: AllOverrides) {
  // Clean up empty file entries
  const cleaned: AllOverrides = {};
  for (const [file, fileOverrides] of Object.entries(overrides)) {
    if (Object.keys(fileOverrides).length > 0) {
      cleaned[file] = fileOverrides;
    }
  }
  if (Object.keys(cleaned).length > 0) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function useCheckboxOverrides(filename: string) {
  const [, forceUpdate] = useState(0);
  const checkboxMapRef = useRef<Map<string, boolean>>(new Map());

  const setCheckboxMap = useCallback(
    (map: Map<string, boolean>) => {
      checkboxMapRef.current = map;

      // Reconcile: remove overrides that match source or reference deleted keys
      const all = loadOverrides();
      const fileOverrides = all[filename];
      if (fileOverrides) {
        const reconciled: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(fileOverrides)) {
          if (!map.has(key)) continue; // Checkbox deleted from source
          if (map.get(key) === value) continue; // Override matches source
          reconciled[key] = value;
        }
        if (Object.keys(reconciled).length > 0) {
          all[filename] = reconciled;
        } else {
          delete all[filename];
        }
        saveOverrides(all);
      }
      forceUpdate((n) => n + 1);
    },
    [filename],
  );

  const getChecked = useCallback(
    (key: string): boolean => {
      const all = loadOverrides();
      const fileOverrides = all[filename];
      if (fileOverrides && key in fileOverrides) {
        return fileOverrides[key];
      }
      return checkboxMapRef.current.get(key) ?? false;
    },
    [filename],
  );

  const toggle = useCallback(
    (key: string) => {
      const currentChecked = getChecked(key);
      const newValue = !currentChecked;
      const sourceValue = checkboxMapRef.current.get(key) ?? false;

      const all = loadOverrides();
      if (newValue === sourceValue) {
        // Remove override — back to source state
        if (all[filename]) {
          delete all[filename][key];
          if (Object.keys(all[filename]).length === 0) {
            delete all[filename];
          }
        }
      } else {
        all[filename] = all[filename] || {};
        all[filename][key] = newValue;
      }
      saveOverrides(all);
      forceUpdate((n) => n + 1);
    },
    [filename, getChecked],
  );

  return { getChecked, toggle, setCheckboxMap };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd internal/frontend && pnpm test src/hooks/useCheckboxOverrides.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add internal/frontend/src/hooks/useCheckboxOverrides.ts internal/frontend/src/hooks/useCheckboxOverrides.test.ts
git commit -m "feat: add useCheckboxOverrides hook with localStorage persistence"
```

---

## Task 5: Integrate into MarkdownViewer

**Files:**

- Modify: `internal/frontend/src/components/MarkdownViewer.tsx:27-34` — update sanitize schema
- Modify: `internal/frontend/src/components/MarkdownViewer.tsx:448-510` — add custom `input` component
- Modify: `internal/frontend/src/components/MarkdownViewer.tsx:532-544` — add plugin to pipeline

This task wires everything together in the existing `MarkdownViewer` component.

- [ ] **Step 1: Add imports**

Add to the top of `MarkdownViewer.tsx`:

```typescript
import { rehypeCheckboxKeys } from "../plugins/rehypeCheckboxKeys";
import { useCheckboxOverrides } from "../hooks/useCheckboxOverrides";
```

- [ ] **Step 2: Update sanitize schema**

In `MarkdownViewer.tsx`, update the `sanitizeSchema` definition (around line 27-34) to allow `data-checkbox-key` on `input` elements:

```typescript
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.["span"] || []), "style"],
    div: [...(defaultSchema.attributes?.["div"] || []), "style", "align"],
    input: [...(defaultSchema.attributes?.["input"] || []), "data-checkbox-key"],
  },
};
```

- [ ] **Step 3: Add the hook and onCheckboxMap callback to the component**

Inside the `MarkdownViewer` function body (after the existing state declarations, around line 407), add:

```typescript
const basename = fileName.split("/").pop() ?? fileName;
const { getChecked, toggle, setCheckboxMap } = useCheckboxOverrides(basename);

const onCheckboxMap = useCallback(
  (map: Map<string, boolean>) => {
    setCheckboxMap(map);
  },
  [setCheckboxMap],
);
```

- [ ] **Step 4: Add custom input component to the components object**

In the `components` useMemo (around line 448), add an `input` entry:

```typescript
input: ({ disabled: _disabled, type, checked, ...props }) => {
  if (type !== "checkbox") {
    return <input type={type} checked={checked} {...props} />;
  }
  const key = (props as Record<string, unknown>)["data-checkbox-key"] as
    | string
    | undefined;
  if (!key) {
    return <input type="checkbox" checked={checked} disabled {...props} />;
  }
  const effectiveChecked = getChecked(key);
  return (
    <input
      type="checkbox"
      checked={effectiveChecked}
      onChange={() => toggle(key)}
      style={{ cursor: "pointer" }}
      {...props}
    />
  );
},
```

Update the `useMemo` dependency array to include `getChecked` and `toggle`.

- [ ] **Step 5: Add rehypeCheckboxKeys to the pipeline**

In the `renderedContent` useMemo, update the `rehypePlugins` array to insert the plugin after `rehypeRaw` and before `rehypeSanitize`:

```typescript
rehypePlugins={[
  rehypeRaw,
  [rehypeCheckboxKeys, { onCheckboxMap }],
  [rehypeSanitize, sanitizeSchema],
  rehypeGithubAlerts,
  rehypeSlug,
  rehypeKatex,
]}
```

Update the `useMemo` dependency array for `renderedContent` to include `onCheckboxMap`.

- [ ] **Step 6: Run all frontend tests**

Run: `cd internal/frontend && pnpm test`
Expected: PASS (all tests)

- [ ] **Step 7: Manual smoke test**

Run: `make dev ARGS="testdata/gfm.md"`

Verify:

1. The GFM task list checkboxes are visible and clickable
2. Clicking a checkbox toggles its state
3. Refresh the page — checkbox state persists
4. Edit `testdata/gfm.md` to check a box in the source — the override is cleaned up on live-reload

- [ ] **Step 8: Commit**

```bash
git add internal/frontend/src/components/MarkdownViewer.tsx
git commit -m "feat: integrate interactive checkboxes into MarkdownViewer"
```

---

## Task 6: Run Full Test Suite and Lint

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `make test`
Expected: PASS (all frontend + Go tests)

- [ ] **Step 2: Run linters**

Run: `make lint`
Expected: PASS (no lint errors)

- [ ] **Step 3: Run frontend formatting check**

Run: `make fmt-check`
Expected: PASS

If formatting issues are found, run `make fmt` and commit:

```bash
git add -A
git commit -m "style: format code"
```
