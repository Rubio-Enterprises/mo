// Only one element is held at a time, module-wide: the deep link, history
// traversal and restore paths live in different hooks, and a newer landing must
// replace an older one rather than fight it.
let releaseActive: (() => void) | null = null;

// Places `el` at `offset` from the top of `sc` and keeps it there while content
// above it changes height (Mermaid, images, KaTeX rendering late), until the
// reader scrolls. Browsers with scroll anchoring already do this natively;
// WebKit has none, so without this a late render pushes the heading away.
export function anchorScroll(sc: HTMLElement, el: HTMLElement, offset = 0): () => void {
  releaseActive?.();

  const position = () => el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  let lastWritten = sc.scrollTop;
  const apply = () => {
    const delta = position() - offset;
    if (Math.abs(delta) < 1) return;
    sc.scrollTop += delta;
    lastWritten = sc.scrollTop;
  };

  const content = el.closest("article") ?? sc.firstElementChild;
  const observer =
    content && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (!el.isConnected) {
            release();
            return;
          }
          apply();
        })
      : null;

  // The scroll event is the one signal every way of scrolling produces (wheel,
  // touch, keys, scrollbar drag, find in page), so it decides when the reader
  // has taken over, rather than a list of input events.
  const onScroll = () => {
    if (!el.isConnected) {
      release();
      return;
    }
    if (sc.scrollTop === lastWritten) return;
    // Native scroll anchoring moved the container and kept the element in place.
    if (Math.abs(position() - offset) < 1) {
      lastWritten = sc.scrollTop;
      return;
    }
    release();
  };

  function release() {
    observer?.disconnect();
    sc.removeEventListener("scroll", onScroll);
    if (releaseActive === release) releaseActive = null;
  }

  apply();
  if (content) observer?.observe(content);
  sc.addEventListener("scroll", onScroll, { passive: true });
  releaseActive = release;
  return release;
}
