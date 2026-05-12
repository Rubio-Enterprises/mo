import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useActiveHeading } from "./useActiveHeading";

type IOCallback = (entries: IntersectionObserverEntry[]) => void;

let activeObservers: { cb: IOCallback; targets: Element[] }[] = [];

class MockIntersectionObserver {
  cb: IOCallback;
  targets: Element[] = [];
  constructor(cb: IOCallback) {
    this.cb = cb;
    activeObservers.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    activeObservers = activeObservers.filter((o) => o !== this);
  }
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}

beforeEach(() => {
  activeObservers = [];
  // @ts-expect-error - test polyfill
  globalThis.IntersectionObserver = MockIntersectionObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useActiveHeading", () => {
  it("returns null when no scroll container", () => {
    const { result } = renderHook(() => useActiveHeading(["a", "b"], null));
    expect(result.current).toBeNull();
  });

  it("returns null when headingIds is empty", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const { result } = renderHook(() => useActiveHeading([], div));
    expect(result.current).toBeNull();
  });

  it("returns null when no matching element exists in the DOM", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const { result } = renderHook(() => useActiveHeading(["missing"], div));
    expect(result.current).toBeNull();
  });

  it("updates active heading when IntersectionObserver fires", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const h1 = document.createElement("h1");
    h1.id = "h1";
    const h2 = document.createElement("h2");
    h2.id = "h2";
    container.append(h1, h2);

    const { result } = renderHook(() => useActiveHeading(["h1", "h2"], container));

    expect(result.current).toBeNull();

    act(() => {
      activeObservers[0].cb([
        { isIntersecting: true, target: h2 } as unknown as IntersectionObserverEntry,
      ]);
    });

    expect(result.current).toBe("h2");
  });

  it("prefers the first matching heading in headingIds order", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const h1 = document.createElement("h1");
    h1.id = "first";
    const h2 = document.createElement("h2");
    h2.id = "second";
    container.append(h1, h2);

    const { result } = renderHook(() => useActiveHeading(["first", "second"], container));

    act(() => {
      activeObservers[0].cb([
        { isIntersecting: true, target: h2 } as unknown as IntersectionObserverEntry,
        { isIntersecting: true, target: h1 } as unknown as IntersectionObserverEntry,
      ]);
    });
    expect(result.current).toBe("first");
  });

  it("resets to null when scrollContainer becomes null", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const h1 = document.createElement("h1");
    h1.id = "h1";
    container.appendChild(h1);

    const { result, rerender } = renderHook(
      ({ root }: { root: HTMLElement | null }) => useActiveHeading(["h1"], root),
      { initialProps: { root: container } },
    );

    act(() => {
      activeObservers[0].cb([
        { isIntersecting: true, target: h1 } as unknown as IntersectionObserverEntry,
      ]);
    });
    expect(result.current).toBe("h1");

    rerender({ root: null });
    expect(result.current).toBeNull();
  });
});
