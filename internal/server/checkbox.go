package server

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	east "github.com/yuin/goldmark/extension/ast"
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
// excluding nested lists and TaskCheckBox nodes. Mirrors extractHastText
// in rehypeCheckboxKeys.ts.
func extractNodeText(n ast.Node, source []byte) string {
	var sb strings.Builder
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		switch child.Kind() {
		case ast.KindList:
			// Skip nested lists — they are separate checkbox items.
			continue
		case east.KindTaskCheckBox:
			// Skip the checkbox node itself.
			continue
		case ast.KindText:
			t, ok := child.(*ast.Text)
			if ok {
				sb.Write(t.Segment.Value(source))
				// Preserve line breaks as newlines to match the frontend's text
				// extraction (rehype represents these as \n text nodes in the HAST).
				if t.SoftLineBreak() || t.HardLineBreak() {
					sb.WriteByte('\n')
				}
			}
		case ast.KindString:
			s, ok := child.(*ast.String)
			if ok {
				sb.Write(s.Value)
			}
		default:
			// Recurse into inline elements (emphasis, strong, links, code spans, etc.).
			sb.WriteString(extractNodeText(child, source))
		}
	}
	return sb.String()
}

// extractCheckboxLabel extracts the label text for a checkbox list item.
// For loose list items (where content is wrapped in Paragraphs), only the
// first Paragraph is processed — matching the frontend's rehypeCheckboxKeys
// plugin which breaks after the first <p>.
func extractCheckboxLabel(listItem ast.Node, source []byte) string {
	first := listItem.FirstChild()
	if first == nil {
		return ""
	}
	// For loose lists the first child is a Paragraph; for tight lists it is
	// a TextBlock. In both cases, extract text only from that first block to
	// match the frontend behavior (which processes only the first <p>).
	if first.Kind() == ast.KindParagraph || first.Kind() == ast.KindTextBlock {
		return extractNodeText(first, source)
	}
	// Fallback: extract from the whole item (shouldn't happen for valid GFM task lists).
	return extractNodeText(listItem, source)
}

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

	if err := ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
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
	}); err != nil {
		slog.Warn("failed to walk markdown AST for checkboxes", "error", err)
	}

	return result, ordered
}
