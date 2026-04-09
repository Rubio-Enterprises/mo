import { useEffect, useRef } from "react";

interface SelectionActionBarProps {
  selectedCount: number;
  totalCount: number;
  onCheck: () => void;
  onUncheck: () => void;
  onCancel: () => void;
}

export function SelectionActionBar({
  selectedCount,
  totalCount,
  onCheck,
  onUncheck,
  onCancel,
}: SelectionActionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  // Auto-focus the bar for keyboard accessibility.
  useEffect(() => {
    barRef.current?.focus();
  }, []);

  return (
    <div
      ref={barRef}
      tabIndex={-1}
      data-selection-action-bar
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 bg-gh-bg-sidebar border border-gh-border rounded-lg shadow-lg text-sm outline-none"
    >
      <span className="text-gh-text-secondary font-medium">
        {selectedCount} of {totalCount} selected
      </span>
      <span className="text-gh-border">|</span>
      <button
        className="px-2 py-1 rounded text-xs font-medium bg-transparent border border-gh-border text-gh-text-secondary hover:bg-gh-bg-hover cursor-pointer transition-colors duration-150"
        onClick={onCheck}
      >
        Check
      </button>
      <button
        className="px-2 py-1 rounded text-xs font-medium bg-transparent border border-gh-border text-gh-text-secondary hover:bg-gh-bg-hover cursor-pointer transition-colors duration-150"
        onClick={onUncheck}
      >
        Uncheck
      </button>
      <button
        className="px-2 py-1 rounded text-xs font-medium bg-transparent border-none text-gh-text-secondary hover:text-gh-text cursor-pointer transition-colors duration-150"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
