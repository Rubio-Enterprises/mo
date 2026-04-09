interface UncheckAllButtonProps {
  onUncheckAll: () => void;
}

export function UncheckAllButton({ onUncheckAll }: UncheckAllButtonProps) {
  return (
    <button
      type="button"
      className="flex items-center justify-center bg-transparent border border-gh-border rounded-md p-1.5 text-gh-text-secondary cursor-pointer transition-colors duration-150 hover:bg-gh-bg-hover"
      onClick={onUncheckAll}
      aria-label="Uncheck all checkboxes"
      title="Uncheck all checkboxes"
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
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l6 6M15 9l-6 6" />
      </svg>
    </button>
  );
}
