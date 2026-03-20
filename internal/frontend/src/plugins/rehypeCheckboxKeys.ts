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

export function computeCheckboxKey(
  rawText: string,
  occurrences: Map<string, number>,
): string {
  const base = rawText.trim() || "__empty";
  const count = (occurrences.get(base) ?? 0) + 1;
  occurrences.set(base, count);
  return count === 1 ? base : `${base}#${count}`;
}
