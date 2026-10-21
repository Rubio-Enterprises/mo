import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { anchorScroll } from "./scrollAnchor";

let resizeCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  private callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe() {
    resizeCallbacks.push(this.callback);
  }
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((cb) => cb !== this.callback);
  }
}

function resize() {
  for (const cb of [...resizeCallbacks]) cb();
}

// A scroller whose heading sits `headingTop` pixels into the content, so its
// position in the viewport follows scrollTop the way real layout does.
function setup(initialHeadingTop: number) {
  const sc = document.createElement("div");
  const article = document.createElement("article");
  const heading = document.createElement("h2");
  article.appendChild(heading);
  sc.appendChild(article);
  document.body.appendChild(sc);
  const layout = { headingTop: initialHeadingTop };
  sc.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  heading.getBoundingClientRect = () => ({ top: layout.headingTop - sc.scrollTop }) as DOMRect;
  const offset = () => heading.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  const scrollBy = (delta: number) => {
    sc.scrollTop += delta;
    sc.dispatchEvent(new Event("scroll"));
  };
  return { sc, heading, layout, offset, scrollBy };
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("anchorScroll", () => {
  it("places the element at the offset", () => {
    const { sc, heading, offset } = setup(500);

    anchorScroll(sc, heading, 40);

    expect(offset()).toBe(40);
  });

  it("keeps the element in place when content above it grows", () => {
    const { sc, heading, layout, offset } = setup(500);
    anchorScroll(sc, heading);

    layout.headingTop += 190;
    resize();

    expect(sc.scrollTop).toBe(690);
    expect(offset()).toBe(0);
  });

  it("ignores the scroll event caused by its own adjustment", () => {
    const { sc, heading, layout, offset } = setup(500);
    anchorScroll(sc, heading);

    layout.headingTop += 190;
    resize();
    sc.dispatchEvent(new Event("scroll"));
    layout.headingTop += 100;
    resize();

    expect(offset()).toBe(0);
  });

  it("lets go once the reader scrolls", () => {
    const { sc, heading, layout, offset, scrollBy } = setup(500);
    anchorScroll(sc, heading);

    scrollBy(-120);
    layout.headingTop += 190;
    resize();

    expect(offset()).toBe(310);
  });

  it("keeps holding after native scroll anchoring moved the container", () => {
    const { sc, heading, layout, offset, scrollBy } = setup(500);
    anchorScroll(sc, heading);

    // The browser compensates a growth of 190 above the element on its own.
    layout.headingTop += 190;
    scrollBy(190);
    layout.headingTop += 100;
    resize();

    expect(offset()).toBe(0);
  });

  it("releases the previous element when a new one is anchored", () => {
    const first = setup(500);
    const second = setup(800);
    anchorScroll(first.sc, first.heading);
    anchorScroll(second.sc, second.heading);

    first.layout.headingTop += 190;
    resize();

    expect(first.offset()).toBe(190);
    expect(second.offset()).toBe(0);
  });

  it("lets go when the element leaves the document", () => {
    const { sc, heading, layout } = setup(500);
    anchorScroll(sc, heading);

    heading.remove();
    layout.headingTop += 190;
    resize();

    expect(sc.scrollTop).toBe(500);
  });

  it("stops holding when released by its caller", () => {
    const { sc, heading, layout, offset } = setup(500);
    const release = anchorScroll(sc, heading);

    release();
    layout.headingTop += 190;
    resize();

    expect(offset()).toBe(190);
  });
});
