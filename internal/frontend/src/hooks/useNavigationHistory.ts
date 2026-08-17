import { useCallback, useState } from "react";

export interface NavEntry {
  fileId: string;
  scrollTop: number;
  headingId: string | null;
  headingOffset: number;
}

export function useNavigationHistory() {
  const [backStack, setBackStack] = useState<NavEntry[]>([]);
  const [forwardStack, setForwardStack] = useState<NavEntry[]>([]);

  const navigate = useCallback((from: NavEntry) => {
    setBackStack((prev) => [...prev, from]);
    setForwardStack([]);
  }, []);

  const goBack = useCallback(
    (current: NavEntry): NavEntry | null => {
      if (backStack.length === 0) return null;
      const entry = backStack[backStack.length - 1];
      setBackStack(backStack.slice(0, -1));
      setForwardStack((prev) => [...prev, current]);
      return entry;
    },
    [backStack],
  );

  const goForward = useCallback(
    (current: NavEntry): NavEntry | null => {
      if (forwardStack.length === 0) return null;
      const entry = forwardStack[forwardStack.length - 1];
      setForwardStack(forwardStack.slice(0, -1));
      setBackStack((prev) => [...prev, current]);
      return entry;
    },
    [forwardStack],
  );

  return {
    navigate,
    goBack,
    goForward,
    canGoBack: backStack.length > 0,
    canGoForward: forwardStack.length > 0,
  };
}
