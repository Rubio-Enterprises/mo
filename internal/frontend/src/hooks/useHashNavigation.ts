import { useEffect } from "react";
import { headingIdFromHash, scrollToHeading } from "../utils/jumpToHeading";
import { parseFileIdFromSearch, parseGroupFromPath } from "../utils/groups";

// Back/forward between entries that differ only in the hash (left by table of
// contents clicks and in-document anchor links) changes the URL without
// scrolling, because the document scrolls inside a container rather than the
// window. Scroll to the hash's heading, or to the top when the hash is gone.
export function useHashNavigation(
  scrollContainer: HTMLElement | null,
  activeGroup: string,
  activeFileId: string | null,
) {
  useEffect(() => {
    const handleHashChange = () => {
      // A traversal to another file also fires hashchange, after popstate has
      // queued the file switch. That file has not rendered yet, and its own
      // content render decides where it starts.
      if (
        parseGroupFromPath(window.location.pathname) !== activeGroup ||
        parseFileIdFromSearch(window.location.search) !== activeFileId
      ) {
        return;
      }
      const id = headingIdFromHash(window.location.hash);
      if (id) {
        scrollToHeading(id);
        return;
      }
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollContainer?.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [scrollContainer, activeGroup, activeFileId]);
}
