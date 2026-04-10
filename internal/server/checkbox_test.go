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

	t.Run("soft line break preserved in key", func(t *testing.T) {
		md := "- [ ] First line\n  continued text\n"
		sources := ExtractCheckboxSources(md)
		want := "First line\ncontinued text"
		if _, ok := sources[want]; !ok {
			t.Fatalf("expected key %q, got keys: %v", want, sources)
		}
	})

	t.Run("loose list uses only first paragraph", func(t *testing.T) {
		md := "- [ ] Task A\n\n  More details\n\n- [ ] Task B\n"
		sources := ExtractCheckboxSources(md)
		if _, ok := sources["Task A"]; !ok {
			t.Fatalf("expected key 'Task A', got keys: %v", sources)
		}
		if _, ok := sources["Task B"]; !ok {
			t.Fatalf("expected key 'Task B', got keys: %v", sources)
		}
	})
}
