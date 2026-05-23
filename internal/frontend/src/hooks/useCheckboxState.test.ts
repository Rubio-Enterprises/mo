import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCheckboxState } from "./useCheckboxState";

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => handler(url, init)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCheckboxState", () => {
  it("loads checkbox state on mount", async () => {
    mockFetch(async () => {
      return new Response(
        JSON.stringify({
          sources: { a: false, b: true },
          overrides: { a: true },
          orderedKeys: ["a", "b"],
        }),
        { status: 200 },
      );
    });

    const { result } = renderHook(() => useCheckboxState("file-1"));

    await waitFor(() => expect(result.current.checkboxesLoaded).toBe(true));
    expect(result.current.hasCheckboxes).toBe(true);
    expect(result.current.totalCheckboxes).toBe(2);
    expect(result.current.orderedKeys).toEqual(["a", "b"]);
    expect(result.current.getChecked("a")).toBe(true); // override wins
    expect(result.current.getChecked("b")).toBe(true); // source
    expect(result.current.getChecked("missing")).toBe(false);
  });

  it("resets to empty state on fetch error and marks loaded", async () => {
    mockFetch(async () => new Response(null, { status: 500 }));

    const { result } = renderHook(() => useCheckboxState("file-err"));
    await waitFor(() => expect(result.current.checkboxesLoaded).toBe(true));
    expect(result.current.hasCheckboxes).toBe(false);
    expect(result.current.orderedKeys).toEqual([]);
  });

  it("toggle calls the API with negated state", async () => {
    let toggleBody: { checked: boolean } | null = null;
    mockFetch(async (url, init) => {
      if (url.includes("/checkboxes/")) {
        toggleBody = JSON.parse((init?.body as string) ?? "{}");
        return new Response(null, { status: 200 });
      }
      return new Response(
        JSON.stringify({ sources: { a: false }, overrides: {}, orderedKeys: ["a"] }),
        { status: 200 },
      );
    });

    const { result } = renderHook(() => useCheckboxState("f"));
    await waitFor(() => expect(result.current.checkboxesLoaded).toBe(true));

    act(() => result.current.toggle("a"));
    await waitFor(() => expect(toggleBody).not.toBeNull());
    expect((toggleBody as { checked: boolean } | null)?.checked).toBe(true);
  });

  it("checkAll / uncheckAll call the right endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/checkboxes")) {
        return new Response(
          JSON.stringify({ sources: { a: false }, overrides: {}, orderedKeys: ["a"] }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCheckboxState("f"));
    await waitFor(() => expect(result.current.checkboxesLoaded).toBe(true));

    act(() => result.current.checkAll());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/_/api/files/f/checkboxes/check-all", {
        method: "POST",
      });
    });

    act(() => result.current.uncheckAll());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/_/api/files/f/checkboxes", { method: "DELETE" });
    });
  });

  it("reacts to mo-checkbox-changed custom events for the same fileId", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ sources: { a: false }, overrides: {}, orderedKeys: ["a"] }), {
          status: 200,
        }),
    );
    const { result } = renderHook(() => useCheckboxState("file-1"));
    await waitFor(() => expect(result.current.checkboxesLoaded).toBe(true));

    const prevRevision = result.current.checkboxRevision;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("mo-checkbox-changed", {
          detail: {
            fileId: "file-1",
            sources: { a: true },
            overrides: {},
            orderedKeys: ["a"],
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.getChecked("a")).toBe(true);
      expect(result.current.checkboxRevision).toBe(prevRevision + 1);
    });
  });

  it("ignores mo-checkbox-changed events for other fileIds", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ sources: { a: false }, overrides: {}, orderedKeys: ["a"] }), {
          status: 200,
        }),
    );
    const { result } = renderHook(() => useCheckboxState("file-1"));
    await waitFor(() => expect(result.current.checkboxesLoaded).toBe(true));
    const before = result.current.checkboxRevision;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("mo-checkbox-changed", {
          detail: { fileId: "other", sources: { a: true }, overrides: {} },
        }),
      );
    });

    expect(result.current.checkboxRevision).toBe(before);
    expect(result.current.getChecked("a")).toBe(false);
  });
});
