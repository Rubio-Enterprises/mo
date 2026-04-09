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

// ExtractCheckboxSources parses markdown content and returns a map of
// checkbox key to source checked state. Keys are computed using the same
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

		// Extract label text from the list item, excluding nested lists
		// and the checkbox node itself.
		labelText := extractNodeText(n, source)
		key := computeCheckboxKey(labelText, occurrences)
		result[key] = checkbox.IsChecked

		return ast.WalkContinue, nil
	})

	return result
}
