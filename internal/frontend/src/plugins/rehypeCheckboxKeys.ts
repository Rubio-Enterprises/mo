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
