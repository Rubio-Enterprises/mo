import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export const SCROLL_SESSION_KEY = "mo-scroll-context";

interface ScrollContext {
  headingId: string | null;
  relativeOffset: number;
  rawScrollTop: number;
  fileId: string;
  url: string;
}

export function useScrollRestoration(
  scrollContainer: HTMLElement | null,
  activeHeadingId: string | null,
  activeFileId: string | null,
) {
  const savedContextRef = useRef<ScrollContext | null>(null);
  const pendingRestoreRef = useRef(false);
  const sessionRestoredRef = useRef(false);

  // Single ref object for stable access in beforeunload and captureScrollPosition
  const latestRef = useRef({ scrollContainer, activeHeadingId, activeFileId });
  useLayoutEffect(() => {
    latestRef.current = { scrollContainer, activeHeadingId, activeFileId };
  });

  const captureScrollPosition = useCallback(() => {
    const {
      scrollContainer: sc,
      activeFileId: fileId,
      activeHeadingId: headingId,
    } = latestRef.current;
    if (!sc || !fileId) {
      console.debug("[scroll-restore] capture SKIPPED: no scrollContainer or fileId", { sc: !!sc, fileId });
      return;
    }

    const rawScrollTop = sc.scrollTop;
    let relativeOffset = 0;

    if (headingId) {
      const headingEl = document.getElementById(headingId);
      if (headingEl) {
        relativeOffset = headingEl.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      }
    }

    const ctx: ScrollContext = {
      headingId,
      relativeOffset,
      rawScrollTop,
      fileId,
      url: window.location.pathname,
    };

    console.debug("[scroll-restore] CAPTURED", ctx);

    savedContextRef.current = ctx;
    pendingRestoreRef.current = true;

    try {
      sessionStorage.setItem(SCROLL_SESSION_KEY, JSON.stringify(ctx));
    } catch {
      // sessionStorage may be unavailable
    }
  }, []);

  const restoreFromContext = useCallback((ctx: ScrollContext, source: string) => {
    const sc = latestRef.current.scrollContainer;
    if (!sc) {
      console.debug(`[scroll-restore] restore(${source}) SKIPPED: no scrollContainer`);
      return;
    }

    if (ctx.headingId) {
      const headingEl = document.getElementById(ctx.headingId);
      if (headingEl) {
        const currentOffset =
          headingEl.getBoundingClientRect().top - sc.getBoundingClientRect().top;
        const newScrollTop = sc.scrollTop + currentOffset - ctx.relativeOffset;
        console.debug(`[scroll-restore] restore(${source}) via heading "${ctx.headingId}": scrollTop ${sc.scrollTop} -> ${newScrollTop} (currentOffset=${currentOffset}, relativeOffset=${ctx.relativeOffset})`);
        sc.scrollTop = newScrollTop;
        return;
      }
      console.debug(`[scroll-restore] restore(${source}) heading "${ctx.headingId}" NOT FOUND in DOM, falling back to rawScrollTop`);
    }

    console.debug(`[scroll-restore] restore(${source}) via rawScrollTop: ${ctx.rawScrollTop}`);
    sc.scrollTop = ctx.rawScrollTop;
  }, []);

  const onContentRendered = useCallback(() => {
    const fileId = latestRef.current.activeFileId;
    console.debug("[scroll-restore] onContentRendered called", {
      fileId,
      pendingRestore: pendingRestoreRef.current,
      hasSavedContext: !!savedContextRef.current,
      sessionRestored: sessionRestoredRef.current,
    });

    // Path A: React re-render (ref-based)
    if (pendingRestoreRef.current && savedContextRef.current) {
      const ctx = savedContextRef.current;
      if (ctx.fileId === fileId) {
        console.debug("[scroll-restore] Path A: restoring for fileId match");
        restoreFromContext(ctx, "pathA");
      } else {
        console.debug("[scroll-restore] Path A: fileId MISMATCH", { saved: ctx.fileId, current: fileId });
      }
      savedContextRef.current = null;
      pendingRestoreRef.current = false;
      try {
        sessionStorage.removeItem(SCROLL_SESSION_KEY);
      } catch {
        // ignore
      }
      return;
    }

    // Path B: Full page reload (sessionStorage-based, one-shot)
    if (sessionRestoredRef.current) {
      console.debug("[scroll-restore] Path B: already restored, skipping");
      return;
    }
    sessionRestoredRef.current = true;
    try {
      const stored = sessionStorage.getItem(SCROLL_SESSION_KEY);
      if (stored) {
        const ctx: ScrollContext = JSON.parse(stored);
        sessionStorage.removeItem(SCROLL_SESSION_KEY);
        if (ctx.fileId === fileId && ctx.url === window.location.pathname) {
          console.debug("[scroll-restore] Path B: restoring from sessionStorage");
          restoreFromContext(ctx, "pathB");
        } else {
          console.debug("[scroll-restore] Path B: fileId/url MISMATCH", { saved: ctx, current: { fileId, url: window.location.pathname } });
        }
      } else {
        console.debug("[scroll-restore] Path B: nothing in sessionStorage");
      }
    } catch {
      // ignore
    }
  }, [restoreFromContext]);

  // Capture scroll position before any page unload
  useEffect(() => {
    window.addEventListener("beforeunload", captureScrollPosition);
    return () => window.removeEventListener("beforeunload", captureScrollPosition);
  }, [captureScrollPosition]);

  return { captureScrollPosition, onContentRendered };
}
