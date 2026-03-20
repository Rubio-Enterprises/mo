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
