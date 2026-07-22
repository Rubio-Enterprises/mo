import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { fetchFileContent, rawFileUrl } from "../hooks/useApi";
import type { FileType } from "../hooks/useApi";
import { rendererRegistry } from "../renderers/registry";
import type { TocHeading, RendererProps, CheckboxInfo } from "../renderers/registry";
import { formatFileLabel } from "../utils/fileLabel";
import type { FontSize } from "./FontSizeToggle";
import type { ZoomContent } from "./ZoomModal";
import { TocToggle } from "./TocToggle";
import { RawToggle } from "./RawToggle";
import { CopyButton } from "./CopyButton";
import { CloseFileButton } from "./CloseFileButton";
import { CheckboxActionsButton } from "./CheckboxActionsButton";

interface FileViewerProps {
  activeGroup: string;
  fileId: string;
  fileName: string;
  fileType: FileType;
  title?: string;
  filePath?: string;
  uploaded?: boolean;
  scrollContainer?: HTMLElement | null;
  revision: number;
  onFileOpened: (fileId: string, hash?: string) => void;
  onHeadingsChange: (headings: TocHeading[]) => void;
  onContentRendered?: () => void;
  isTocOpen: boolean;
  onTocToggle: () => void;
  onRemoveFile: () => void;
  isWide: boolean;
  fontSize: FontSize;
  onZoom?: (content: ZoomContent) => void;
  scrollToHeading?: string | null;
  onScrolledToHeading?: () => void;
  searchQuery?: string | null;
}

export function FileViewer({
  activeGroup,
  fileId,
  fileName,
  fileType,
  title,
  filePath,
  uploaded,
  scrollContainer,
  revision,
  onFileOpened,
  onHeadingsChange,
  onContentRendered,
  isTocOpen,
  onTocToggle,
  onRemoveFile,
  isWide,
  fontSize,
  onZoom,
  scrollToHeading,
  onScrolledToHeading,
  searchQuery,
}: FileViewerProps) {
  const entry = rendererRegistry[fileType];
  const { features, contentSource } = entry;
  const Component = entry.component;

  const fetchKey = `${activeGroup}::${fileId}`;
  const [content, setContent] = useState("");
  const [contentKey, setContentKey] = useState("");
  const [isRawView, setIsRawView] = useState(false);
  const [checkboxInfo, setCheckboxInfo] = useState<CheckboxInfo | null>(null);
  const [showFullLabel, setShowFullLabel] = useState(false);

  const articleRef = useRef<HTMLElement>(null);
  const stickyLabelRef = useRef<HTMLDivElement>(null);

  const onCheckboxInfo = useCallback((info: CheckboxInfo) => {
    setCheckboxInfo(info);
  }, []);

  useEffect(() => {
    if (contentSource !== "text") return;
    let cancelled = false;
    fetchFileContent(activeGroup, fileId)
      .then((data) => {
        if (!cancelled) {
          setContent(data.content);
          setContentKey(fetchKey);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent("Failed to load file.");
          setContentKey(fetchKey);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeGroup, fileId, revision, contentSource, fetchKey]);

  useEffect(() => {
    if (!features.headings) onHeadingsChange([]);
  }, [features.headings, onHeadingsChange]);

  useEffect(() => {
    setIsRawView(false);
    setCheckboxInfo(null);
  }, [activeGroup, fileId]);

  useEffect(() => {
    const article = articleRef.current;
    const label = stickyLabelRef.current;
    if (!scrollContainer || !article || !label) {
      setShowFullLabel(false);
      return;
    }

    let heading: Element | null = null;
    let frame = requestAnimationFrame(() => {
      heading = article.querySelector("h1, h2, h3, h4, h5, h6");
      if (!heading) {
        setShowFullLabel(false);
        return;
      }
      setShowFullLabel(
        heading.getBoundingClientRect().bottom <= label.getBoundingClientRect().bottom,
      );
    });

    const update = () => {
      frame = 0;
      if (!heading) return;
      setShowFullLabel(
        heading.getBoundingClientRect().bottom <= label.getBoundingClientRect().bottom,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    scrollContainer.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      scrollContainer.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [contentKey, revision, scrollContainer, isWide, fontSize, isTocOpen]);

  const loading = contentSource === "text" && contentKey !== fetchKey;
  if (loading) {
    return (
      <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
        Loading...
      </div>
    );
  }

  const baseProps = {
    activeGroup,
    fileId,
    fileName,
    revision,
    isRawView,
    onFileOpened,
    onHeadingsChange,
    onContentRendered,
    onCheckboxInfo,
    scrollContainer,
    fontSize,
    onZoom,
    scrollToHeading,
    onScrolledToHeading,
    searchQuery,
  };

  const rendererProps: RendererProps =
    contentSource === "text"
      ? { ...baseProps, contentSource: "text" as const, content }
      : {
          ...baseProps,
          contentSource: "raw" as const,
          rawUrl: rawFileUrl(activeGroup, fileId, revision),
        };

  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div
          ref={stickyLabelRef}
          className={`sticky -top-8 z-20 mx-auto mb-4 border-b border-gh-border bg-gh-bg py-2 text-sm font-medium text-right text-gh-text-secondary overflow-hidden text-ellipsis whitespace-nowrap${isWide ? "" : " max-w-[980px]"}`}
          title={!uploaded && filePath ? filePath : fileName}
        >
          {showFullLabel ? formatFileLabel(fileName, title) : fileName}
        </div>
        <article
          ref={articleRef}
          className={`markdown-body min-w-0${isWide ? " markdown-body--wide" : ""}${fontSize !== "medium" ? ` markdown-body--${fontSize}` : ""}`}
        >
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
                Loading...
              </div>
            }
          >
            <Component {...rendererProps} />
          </Suspense>
        </article>
      </div>
      <div className="shrink-0 sticky -top-4 self-start flex flex-col gap-2 -mr-4 -mt-4">
        {features.toc && <TocToggle isTocOpen={isTocOpen} onToggle={onTocToggle} />}
        {features.raw && <RawToggle isRaw={isRawView} onToggle={() => setIsRawView((v) => !v)} />}
        {features.copyable && <CopyButton content={content} />}
        {checkboxInfo?.hasCheckboxes && (
          <CheckboxActionsButton
            onCheckAll={checkboxInfo.checkAll}
            onUncheckAll={checkboxInfo.uncheckAll}
          />
        )}
        <CloseFileButton onClose={onRemoveFile} uploaded={uploaded} />
      </div>
    </div>
  );
}
