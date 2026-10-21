import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHashNavigation } from "./useHashNavigation";

function addHeading(id: string) {
  const el = document.createElement("h2");
  el.id = id;
  el.scrollIntoView = vi.fn();
  document.body.appendChild(el);
  return el;
}

function makeContainer() {
  const el = document.createElement("div");
  el.scrollTo = vi.fn() as typeof el.scrollTo;
  return el;
}

// Browsers fire hashchange after a traversal has already updated the URL.
function traverseTo(url: string) {
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

beforeEach(() => {
  window.history.replaceState(null, "", "/?file=file1#intro");
});

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("useHashNavigation", () => {
  it("scrolls to the heading named by the new hash", () => {
    const heading = addHeading("usage");
    renderHook(() => useHashNavigation(makeContainer(), "default", "file1"));

    traverseTo("/?file=file1#usage");

    expect(heading.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("decodes a percent-encoded hash before looking up the heading", () => {
    const heading = addHeading("使い方");
    renderHook(() => useHashNavigation(makeContainer(), "default", "file1"));

    traverseTo(`/?file=file1#${encodeURIComponent("使い方")}`);

    expect(heading.scrollIntoView).toHaveBeenCalled();
  });

  it("scrolls the container to the top when the hash is removed", () => {
    const container = makeContainer();
    renderHook(() => useHashNavigation(container, "default", "file1"));

    traverseTo("/?file=file1");

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("ignores a hash change that belongs to another file", () => {
    const heading = addHeading("usage");
    const container = makeContainer();
    renderHook(() => useHashNavigation(container, "default", "file1"));

    traverseTo("/?file=file2#usage");

    expect(heading.scrollIntoView).not.toHaveBeenCalled();
    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  it("ignores a hash change that belongs to another group", () => {
    const heading = addHeading("usage");
    renderHook(() => useHashNavigation(makeContainer(), "default", "file1"));

    traverseTo("/design?file=file1#usage");

    expect(heading.scrollIntoView).not.toHaveBeenCalled();
  });

  it("stops listening after unmount", () => {
    const heading = addHeading("usage");
    const { unmount } = renderHook(() => useHashNavigation(makeContainer(), "default", "file1"));
    unmount();

    traverseTo("/?file=file1#usage");

    expect(heading.scrollIntoView).not.toHaveBeenCalled();
  });
});
