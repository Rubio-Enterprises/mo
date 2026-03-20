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

  const goBack = useCallback((current: NavEntry): NavEntry | null => {
    let entry: NavEntry | null = null;
    setBackStack((prev) => {
      if (prev.length === 0) return prev;
      entry = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    if (entry) {
      setForwardStack((prev) => [...prev, current]);
    }
    return entry;
  }, []);

  const goForward = useCallback((current: NavEntry): NavEntry | null => {
    let entry: NavEntry | null = null;
    setForwardStack((prev) => {
      if (prev.length === 0) return prev;
      entry = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    if (entry) {
      setBackStack((prev) => [...prev, current]);
    }
    return entry;
  }, []);

  return {
    navigate,
    goBack,
    goForward,
    canGoBack: backStack.length > 0,
    canGoForward: forwardStack.length > 0,
  };
}
