import { useState, useCallback, useRef } from "react";

const STORAGE_KEY = "mo-checkbox-overrides";

type AllOverrides = Record<string, Record<string, boolean>>;

function loadOverrides(): AllOverrides {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveOverrides(overrides: AllOverrides) {
  const cleaned: AllOverrides = {};
  for (const [file, fileOverrides] of Object.entries(overrides)) {
    if (Object.keys(fileOverrides).length > 0) {
      cleaned[file] = fileOverrides;
    }
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
}

export function useCheckboxOverrides(filename: string) {
  const [version, setVersion] = useState(0);
  const checkboxMapRef = useRef<Map<string, boolean>>(new Map());

  const setCheckboxMap = useCallback(
    (map: Map<string, boolean>) => {
      checkboxMapRef.current = map;

      const all = loadOverrides();
      const fileOverrides = all[filename];
      if (fileOverrides) {
        const reconciled: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(fileOverrides)) {
          if (!map.has(key)) continue;
          if (map.get(key) === value) continue;
          reconciled[key] = value;
        }
        if (Object.keys(reconciled).length > 0) {
          all[filename] = reconciled;
        } else {
          delete all[filename];
        }
        saveOverrides(all);
      }
      setVersion((n) => n + 1);
    },
    [filename],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version ensures re-render after toggle
  const getChecked = useCallback(
    (key: string): boolean => {
      const all = loadOverrides();
      const fileOverrides = all[filename];
      if (fileOverrides && key in fileOverrides) {
        return fileOverrides[key];
      }
      return checkboxMapRef.current.get(key) ?? false;
    },
    [filename, version],
  );

  const toggle = useCallback(
    (key: string) => {
      const currentChecked = getChecked(key);
      const newValue = !currentChecked;
      const sourceValue = checkboxMapRef.current.get(key) ?? false;

      const all = loadOverrides();
      if (newValue === sourceValue) {
        if (all[filename]) {
          delete all[filename][key];
          if (Object.keys(all[filename]).length === 0) {
            delete all[filename];
          }
        }
      } else {
        all[filename] = all[filename] || {};
        all[filename][key] = newValue;
      }
      saveOverrides(all);
      setVersion((n) => n + 1);
    },
    [filename, getChecked],
  );

  return { getChecked, toggle, setCheckboxMap };
}
