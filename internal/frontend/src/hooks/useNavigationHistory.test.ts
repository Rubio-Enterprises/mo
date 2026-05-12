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

  it("goBack on empty stack does nothing", () => {
    const { result } = renderHook(() => useNavigationHistory());
    act(() => {
      result.current.goBack(entry("current"));
    });
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });

  it("goBack after navigate clears back stack", () => {
    const { result } = renderHook(() => useNavigationHistory());

    act(() => result.current.navigate(entry("a")));
    act(() => {
      result.current.goBack(entry("current"));
    });
    expect(result.current.canGoBack).toBe(false);
  });

  it("goForward on empty stack does nothing", () => {
    const { result } = renderHook(() => useNavigationHistory());
    act(() => {
      result.current.goForward(entry("c"));
    });
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });
});
