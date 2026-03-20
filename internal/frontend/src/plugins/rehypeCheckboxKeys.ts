import { visit } from "unist-util-visit";
import type { Root, Node, Element as HastElement, Text as HastText } from "hast";

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

      const parentEl = parent as HastElement | null;
      if (!parentEl || parentEl.type !== "element") return;

      let labelText = "";
      for (const child of parentEl.children) {
        if (child === node) continue;
        if (
          child.type === "element" &&
          ((child as HastElement).tagName === "ul" ||
           (child as HastElement).tagName === "ol")
        ) {
          continue;
        }
        // For <p> children (loose lists), take only the first <p>
        if (child.type === "element" && (child as HastElement).tagName === "p") {
          const pEl = child as HastElement;
          const hasInput = pEl.children.some(
            (c) =>
              c.type === "element" &&
              (c as HastElement).tagName === "input" &&
              (c as HastElement).properties?.type === "checkbox",
          );
          if (hasInput) {
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
          break;
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
