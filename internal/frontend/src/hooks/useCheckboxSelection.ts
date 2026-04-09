import { useState, useCallback, useEffect, useRef } from "react";

interface CheckboxSelectionResult {
  /** The set of selected checkbox keys. */
  selectedKeys: string[];
  /** Whether the given key is currently selected. */
  isSelected: (key: string) => boolean;
  /** Handle a shift-click on a checkbox key. Sets anchor or completes range. */
  onShiftClick: (key: string) => void;
  /** Clear all selection state. */
  clearSelection: () => void;
}

/**
 * Manages shift-click range selection for checkboxes.
 * @param articleRef - ref to the article element containing checkbox elements with data-checkbox-key attributes.
 */
export function useCheckboxSelection(
  articleRef: React.RefObject<HTMLElement | null>,
): CheckboxSelectionResult {
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const selectedSetRef = useRef(new Set<string>());

  // Keep set ref in sync.
  useEffect(() => {
    selectedSetRef.current = new Set(selectedKeys);
  }, [selectedKeys]);

  const isSelected = useCallback((key: string): boolean => selectedSetRef.current.has(key), []);

  const getDocumentOrder = useCallback((): string[] => {
    if (!articleRef.current) return [];
    const inputs = articleRef.current.querySelectorAll<HTMLInputElement>(
      "input[data-checkbox-key]",
    );
    return Array.from(inputs).map((el) => el.getAttribute("data-checkbox-key")!);
  }, [articleRef]);

  const onShiftClick = useCallback(
    (key: string) => {
      if (anchor === null || selectedKeys.length > 0) {
        // No anchor yet, or a range already exists — start fresh.
        setAnchor(key);
        setSelectedKeys([key]);
        return;
      }

      // Anchor is set, no range yet — compute range.
      const order = getDocumentOrder();
      const anchorIdx = order.indexOf(anchor);
      const targetIdx = order.indexOf(key);
      if (anchorIdx === -1 || targetIdx === -1) {
        // Fallback: just select the clicked key.
        setAnchor(key);
        setSelectedKeys([key]);
        return;
      }

      const start = Math.min(anchorIdx, targetIdx);
      const end = Math.max(anchorIdx, targetIdx);
      setSelectedKeys(order.slice(start, end + 1));
    },
    [anchor, selectedKeys.length, getDocumentOrder],
  );

  const clearSelection = useCallback(() => {
    setAnchor(null);
    setSelectedKeys([]);
  }, []);

  // Escape key clears selection.
  useEffect(() => {
    if (selectedKeys.length === 0 && anchor === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearSelection();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedKeys.length, anchor, clearSelection]);

  // Click outside task list items clears selection.
  useEffect(() => {
    if (selectedKeys.length === 0 && anchor === null) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't clear if clicking inside a task list item.
      if (target.closest("li.task-list-item")) return;
      // Don't clear if clicking inside the selection action bar.
      if (target.closest("[data-selection-action-bar]")) return;
      // Don't clear if clicking inside the checkbox actions button.
      if (target.closest("[data-checkbox-actions]")) return;
      clearSelection();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selectedKeys.length, anchor, clearSelection]);

  return { selectedKeys, isSelected, onShiftClick, clearSelection };
}
