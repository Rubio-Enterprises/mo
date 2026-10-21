import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { headingIdFromHash, scrollToHeading } from "../utils/jumpToHeading";
import { parseFileIdFromSearch, parseGroupFromPath } from "../utils/groups";

interface Location {
  group: string;
  fileId: string | null;
}

interface PendingHeading extends Location {
  id: string;
}

function currentLocation(): Location {
  return {
    group: parseGroupFromPath(window.location.pathname),
    fileId: parseFileIdFromSearch(window.location.search),
  };
}

function isSameLocation<T extends Location>(a: T | null, b: Location): a is T {
  return a != null && a.group === b.group && a.fileId === b.fileId;
}

// Back/forward between entries that differ only in the hash (left by table of
// contents clicks and in-document anchor links) changes the URL without
// scrolling, because the document scrolls inside a container rather than the
// window. Scroll to the hash's heading, or to the top when the hash is gone.
// A traversal to another file lands on its hash's heading once that file has
// rendered.
export function useHashNavigation(
  scrollContainer: HTMLElement | null,
  activeGroup: string,
  activeFileId: string | null,
) {
  const pendingRef = useRef<PendingHeading | null>(null);
  // The file whose content is on screen, not the active file state: browsers run
  // a microtask checkpoint between popstate listeners, so App's popstate handler
  // may already have re-rendered with the new file before these listeners run.
  const renderedRef = useRef<Location | null>(null);
  const latestRef = useRef({ scrollContainer, activeGroup, activeFileId });
  useLayoutEffect(() => {
    latestRef.current = { scrollContainer, activeGroup, activeFileId };
  });

  useEffect(() => {
    const handlePopState = () => {
      pendingRef.current = null;
      const location = currentLocation();
      if (isSameLocation(renderedRef.current, location)) return;
      const id = headingIdFromHash(window.location.hash);
      if (id) pendingRef.current = { ...location, id };
    };
    const handleHashChange = () => {
      // A traversal to another file also fires hashchange, after popstate. That
      // file has not rendered yet, so the pending heading is applied on render.
      if (!isSameLocation(renderedRef.current, currentLocation())) return;
      const id = headingIdFromHash(window.location.hash);
      if (id) {
        scrollToHeading(id);
        return;
      }
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      latestRef.current.scrollContainer?.scrollTo({
        top: 0,
        behavior: reduced ? "auto" : "smooth",
      });
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const onContentRendered = useCallback(() => {
    const { scrollContainer: sc, activeGroup: group, activeFileId: fileId } = latestRef.current;
    renderedRef.current = { group, fileId };
    const pending = pendingRef.current;
    if (!isSameLocation(pending, renderedRef.current)) return;
    pendingRef.current = null;
    const headingEl = document.getElementById(pending.id);
    if (sc && headingEl) {
      // Jump rather than scrollIntoView so a smooth scroll does not animate from
      // the top of a document the reader never saw at that position.
      sc.scrollTop += headingEl.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    }
  }, []);

  return { onContentRendered };
}
