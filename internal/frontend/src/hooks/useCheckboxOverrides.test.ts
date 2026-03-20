// internal/frontend/src/hooks/useCheckboxOverrides.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCheckboxOverrides } from "./useCheckboxOverrides";

const STORAGE_KEY = "mo-checkbox-overrides";

beforeEach(() => {
  localStorage.clear();
});

describe("useCheckboxOverrides", () => {
  it("returns source state when no overrides exist", () => {
    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    act(() => {
      result.current.setCheckboxMap(
        new Map([
          ["Item A", false],
          ["Item B", true],
        ]),
      );
    });

    expect(result.current.getChecked("Item A")).toBe(false);
    expect(result.current.getChecked("Item B")).toBe(true);
  });

  it("toggles a checkbox and persists to localStorage", () => {
    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    act(() => {
      result.current.setCheckboxMap(new Map([["Item A", false]]));
    });

    act(() => {
      result.current.toggle("Item A");
    });

    expect(result.current.getChecked("Item A")).toBe(true);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored["test.md"]["Item A"]).toBe(true);
  });

  it("removes override when toggling back to source state", () => {
    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    act(() => {
      result.current.setCheckboxMap(new Map([["Item A", false]]));
    });

    // Toggle on
    act(() => {
      result.current.toggle("Item A");
    });
    expect(result.current.getChecked("Item A")).toBe(true);

    // Toggle off (back to source state)
    act(() => {
      result.current.toggle("Item A");
    });
    expect(result.current.getChecked("Item A")).toBe(false);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored["test.md"]).toBeUndefined();
  });

  it("reconciles overrides when checkbox map changes", () => {
    // Pre-populate localStorage with an override
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "test.md": { "Item A": true, "Deleted": false } }),
    );

    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    // Source now has Item A as checked (matches override) and Deleted is gone
    act(() => {
      result.current.setCheckboxMap(new Map([["Item A", true]]));
    });

    // Item A override should be removed (matches source)
    // Deleted override should be removed (not in source)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored["test.md"]).toBeUndefined();
  });

  it("keeps overrides that differ from source", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "test.md": { "Item A": true } }),
    );

    const { result } = renderHook(() => useCheckboxOverrides("test.md"));

    // Source has Item A unchecked — override should remain
    act(() => {
      result.current.setCheckboxMap(new Map([["Item A", false]]));
    });

    expect(result.current.getChecked("Item A")).toBe(true);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored["test.md"]["Item A"]).toBe(true);
  });

  it("isolates state per filename", () => {
    const { result: hook1 } = renderHook(() =>
      useCheckboxOverrides("file1.md"),
    );
    const { result: hook2 } = renderHook(() =>
      useCheckboxOverrides("file2.md"),
    );

    act(() => {
      hook1.current.setCheckboxMap(new Map([["Item", false]]));
      hook2.current.setCheckboxMap(new Map([["Item", false]]));
    });

    act(() => {
      hook1.current.toggle("Item");
    });

    expect(hook1.current.getChecked("Item")).toBe(true);
    expect(hook2.current.getChecked("Item")).toBe(false);
  });
});
