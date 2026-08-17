import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNavigationHistory, type NavEntry } from "./useNavigationHistory";

function entry(fileId: string, scrollTop = 0): NavEntry {
  return { fileId, scrollTop, headingId: null, headingOffset: 0 };
}

describe("useNavigationHistory", () => {
  it("starts with empty back/forward stacks", () => {
    const { result } = renderHook(() => useNavigationHistory());
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });

  it("navigate pushes onto back stack and clears forward", () => {
    const { result } = renderHook(() => useNavigationHistory());

    act(() => result.current.navigate(entry("a")));
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
  });

  it("multiple navigates extend the back stack", () => {
    const { result } = renderHook(() => useNavigationHistory());

    act(() => result.current.navigate(entry("a")));
    act(() => result.current.navigate(entry("b")));
    act(() => result.current.navigate(entry("c")));
    expect(result.current.canGoBack).toBe(true);
  });

  it("goBack on empty stack returns null and leaves state untouched", () => {
    const { result } = renderHook(() => useNavigationHistory());

    let returned: NavEntry | null | undefined;
    act(() => {
      returned = result.current.goBack(entry("current"));
    });
    expect(returned).toBeNull();
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });

  it("goBack after navigate clears the back stack", () => {
    const { result } = renderHook(() => useNavigationHistory());

    act(() => result.current.navigate(entry("a")));
    act(() => {
      result.current.goBack(entry("current"));
    });
    expect(result.current.canGoBack).toBe(false);
  });

  it("goBack returns the previously pushed entry when the stack is non-empty", () => {
    const { result } = renderHook(() => useNavigationHistory());

    const pushed = entry("a");
    act(() => result.current.navigate(pushed));

    let returned: NavEntry | null | undefined;
    act(() => {
      returned = result.current.goBack(entry("current"));
    });
    expect(returned).toEqual(pushed);
  });

  it("goForward on empty stack returns null and leaves state untouched", () => {
    const { result } = renderHook(() => useNavigationHistory());

    let returned: NavEntry | null | undefined;
    act(() => {
      returned = result.current.goForward(entry("c"));
    });
    expect(returned).toBeNull();
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });
});
