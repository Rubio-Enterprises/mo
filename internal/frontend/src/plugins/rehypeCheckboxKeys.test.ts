// internal/frontend/src/plugins/rehypeCheckboxKeys.test.ts
import { describe, it, expect } from "vitest";
import { extractHastText, computeCheckboxKey, rehypeCheckboxKeys } from "./rehypeCheckboxKeys";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
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
    // remark-gfm requires non-empty text after [ ] to parse as a checkbox;
    // &nbsp; produces a whitespace-only label that trims to empty ("__empty")
    const md = "- [ ] &nbsp;\n- [ ] &nbsp;\n";
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
