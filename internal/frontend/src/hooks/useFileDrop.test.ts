import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useFileDrop } from "./useFileDrop";

// Helpers to fire DragEvent-like custom events on document.
function fireDragEvent(name: string, options: { hasFiles?: boolean; files?: File[] } = {}) {
  const { hasFiles = true, files = [] } = options;
  const types = hasFiles ? ["Files"] : [];
  const fileList = {
    item(i: number) {
      return files[i] ?? null;
    },
    ...files,
    length: files.length,
  };
  const event = new Event(name, { bubbles: true, cancelable: true }) as Event & {
    dataTransfer?: { types: string[]; files: typeof fileList };
  };
  event.dataTransfer = { types, files: fileList };
  document.dispatchEvent(event);
  return event;
}

describe("useFileDrop", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores drag events without Files type", () => {
    const { result } = renderHook(() => useFileDrop("default"));
    act(() => {
      fireDragEvent("dragenter", { hasFiles: false });
    });
    expect(result.current.isDragging).toBe(false);
  });

  it("sets isDragging on first dragenter and clears after balanced leave", () => {
    const { result } = renderHook(() => useFileDrop("default"));

    act(() => {
      fireDragEvent("dragenter");
    });
    expect(result.current.isDragging).toBe(true);

    act(() => {
      fireDragEvent("dragenter");
    });
    expect(result.current.isDragging).toBe(true);

    act(() => {
      fireDragEvent("dragleave");
    });
    expect(result.current.isDragging).toBe(true);

    act(() => {
      fireDragEvent("dragleave");
    });
    expect(result.current.isDragging).toBe(false);
  });

  it("ignores dragleave when counter is already 0", () => {
    const { result } = renderHook(() => useFileDrop("default"));
    act(() => {
      fireDragEvent("dragleave");
    });
    expect(result.current.isDragging).toBe(false);
  });

  it("uploads files smaller than 10MB on drop", async () => {
    renderHook(() => useFileDrop("docs"));

    const file = new File(["# Hello"], "drop.md", { type: "text/markdown" });

    act(() => {
      fireDragEvent("drop", { files: [file] });
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/_/api/files/upload",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("does not upload files larger than 10MB", async () => {
    renderHook(() => useFileDrop("default"));

    // Build a fake oversized file by stubbing size.
    const big = new File([""], "big.md");
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });

    act(() => {
      fireDragEvent("drop", { files: [big] });
    });

    // Give the microtask queue a tick.
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dragover prevents default for files but is otherwise a no-op", () => {
    renderHook(() => useFileDrop("default"));
    const ev = fireDragEvent("dragover");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores drop without Files", async () => {
    renderHook(() => useFileDrop("default"));
    act(() => {
      fireDragEvent("drop", { hasFiles: false });
    });
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
});
