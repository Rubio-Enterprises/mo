interface NavigationButtonsProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

const baseClass =
  "flex items-center justify-center bg-transparent border border-gh-border rounded-md p-1.5 text-gh-header-text transition-colors duration-150";
const enabledClass = `${baseClass} cursor-pointer hover:bg-gh-bg-hover`;
const disabledClass = `${baseClass} opacity-40 cursor-default`;

export function NavigationButtons({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: NavigationButtonsProps) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={canGoBack ? enabledClass : disabledClass}
        onClick={canGoBack ? onBack : undefined}
        disabled={!canGoBack}
        aria-label="Go back"
        title="Go back"
      >
        <svg
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          viewBox="0 0 24 24"
        >
          <polyline points="15,6 9,12 15,18" />
        </svg>
      </button>
      <button
        type="button"
        className={canGoForward ? enabledClass : disabledClass}
        onClick={canGoForward ? onForward : undefined}
        disabled={!canGoForward}
        aria-label="Go forward"
        title="Go forward"
      >
        <svg
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          viewBox="0 0 24 24"
        >
          <polyline points="9,6 15,12 9,18" />
        </svg>
      </button>
    </div>
  );
}
