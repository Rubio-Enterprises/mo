import { useState, useCallback, useEffect, useRef } from "react";
import {
  fetchCheckboxes,
  toggleCheckbox,
  uncheckAllCheckboxes,
  checkAllCheckboxes,
} from "./useApi";

interface CheckboxStateResult {
  getChecked: (key: string) => boolean;
  toggle: (key: string) => void;
  uncheckAll: () => void;
  checkAll: () => void;
  hasCheckboxes: boolean;
  totalCheckboxes: number;
  /** Monotonically increasing counter that bumps on every state change. */
  checkboxRevision: number;
}

export function useCheckboxState(fileId: string): CheckboxStateResult {
  const [sources, setSources] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [checkboxRevision, setCheckboxRevision] = useState(0);
  const sourcesRef = useRef(sources);
  const overridesRef = useRef(overrides);

  // Keep refs in sync for use in callbacks.
  sourcesRef.current = sources;
  overridesRef.current = overrides;

  // Fetch initial state.
  useEffect(() => {
    let cancelled = false;
    fetchCheckboxes(fileId)
      .then((data) => {
        if (!cancelled) {
          setSources(data.sources);
          setOverrides(data.overrides);
        }
      })
      .catch(() => {
        // File may not exist yet or have no checkboxes.
        if (!cancelled) {
          setSources({});
          setOverrides({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  // Listen for SSE-dispatched checkbox change events via custom event.
  // App.tsx dispatches "mo-checkbox-changed" when the SSE event fires.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.fileId === fileId) {
        setSources(detail.sources);
        setOverrides(detail.overrides);
        setCheckboxRevision((r) => r + 1);
      }
    };
    window.addEventListener("mo-checkbox-changed", handler);
    return () => window.removeEventListener("mo-checkbox-changed", handler);
  }, [fileId]);

  const getChecked = useCallback(
    (key: string): boolean => {
      if (key in overrides) {
        return overrides[key];
      }
      return sources[key] ?? false;
    },
    [sources, overrides],
  );

  const toggle = useCallback(
    (key: string) => {
      const currentChecked =
        key in overridesRef.current
          ? overridesRef.current[key]
          : (sourcesRef.current[key] ?? false);
      const newChecked = !currentChecked;
      toggleCheckbox(fileId, key, newChecked).catch(() => {
        // Error handled silently — SSE will provide authoritative state.
      });
    },
    [fileId],
  );

  const uncheckAll = useCallback(() => {
    uncheckAllCheckboxes(fileId).catch(() => {
      // Error handled silently — SSE will provide authoritative state.
    });
  }, [fileId]);

  const checkAll = useCallback(() => {
    checkAllCheckboxes(fileId).catch(() => {
      // Error handled silently — SSE will provide authoritative state.
    });
  }, [fileId]);

  const totalCheckboxes = Object.keys(sources).length;
  const hasCheckboxes = totalCheckboxes > 0;

  return { getChecked, toggle, uncheckAll, checkAll, hasCheckboxes, totalCheckboxes, checkboxRevision };
}
