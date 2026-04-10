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
}
