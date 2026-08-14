import { useState, useRef, useEffect } from "react";

interface CheckboxActionsButtonProps {
  onCheckAll: () => void;
  onUncheckAll: () => void;
}

export function CheckboxActionsButton({ onCheckAll, onUncheckAll }: CheckboxActionsButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="flex items-center justify-center bg-transparent border border-gh-border rounded-md p-1.5 text-gh-text-secondary cursor-pointer transition-colors duration-150 hover:bg-gh-bg-hover"
        onClick={() => setOpen((v) => !v)}
        aria-label="Checkbox actions"
        title="Checkbox actions"
      >
        <svg
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          viewBox="0 0 24 24"
        >
          <rect
            x="3"
            y="3"
            width="18"
            height="18"
            rx="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-36 bg-gh-bg-sidebar border border-gh-border rounded-md shadow-lg z-10 py-1">
          <button
            className="flex items-center w-full px-3 py-1.5 border-none cursor-pointer text-left text-xs bg-transparent text-gh-text-secondary hover:bg-gh-bg-hover transition-colors duration-150"
            onClick={() => {
              onCheckAll();
              setOpen(false);
            }}
          >
            Check all
          </button>
          <button
            className="flex items-center w-full px-3 py-1.5 border-none cursor-pointer text-left text-xs bg-transparent text-gh-text-secondary hover:bg-gh-bg-hover transition-colors duration-150"
            onClick={() => {
              onUncheckAll();
              setOpen(false);
            }}
          >
            Uncheck all
          </button>
        </div>
      )}
    </div>
  );
}
