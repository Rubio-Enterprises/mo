import type { Root, Element as HastElement } from "hast";

interface RehypeCheckboxIndicesOptions {
  orderedKeys: string[];
}

function hasClassName(el: HastElement | null | undefined, cls: string): boolean {
  if (!el || el.type !== "element") return false;
  const className = el.properties?.className;
  if (!Array.isArray(className)) return false;
  return className.includes(cls);
}

function isInsideTaskListItem(ancestors: HastElement[]): boolean {
  // Walk ancestors from nearest → farthest. The nearest <li> ancestor must
  // have class "task-list-item". Loose lists wrap the checkbox in a <p>, so
  // we may traverse through <p> before reaching the <li>.
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const el = ancestors[i];
    if (el.tagName === "li") {
      return hasClassName(el, "task-list-item");
    }
  }
  return false;
}

export function rehypeCheckboxIndices({ orderedKeys }: RehypeCheckboxIndicesOptions) {
  return (tree: Root) => {
    let index = 0;
    const walk = (node: Root | HastElement, ancestors: HastElement[]) => {
      if (node.type === "element") {
        const el = node as HastElement;
        if (el.tagName === "input" && el.properties?.type === "checkbox") {
          if (isInsideTaskListItem(ancestors)) {
            if (index < orderedKeys.length) {
              el.properties = el.properties ?? {};
              el.properties["dataCheckboxKey"] = orderedKeys[index];
            }
            index++;
          }
          return;
        }
      }
      const children = (node as { children?: (HastElement | unknown)[] }).children ?? [];
      const nextAncestors =
        node.type === "element" ? [...ancestors, node as HastElement] : ancestors;
      for (const child of children) {
        if ((child as { type?: string }).type === "element") {
          walk(child as HastElement, nextAncestors);
        }
      }
    };
    walk(tree, []);
  };
}
