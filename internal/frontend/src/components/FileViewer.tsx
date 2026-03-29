import { Suspense, useEffect, useState } from "react";
import { fetchFileContent, rawFileUrl } from "../hooks/useApi";
import type { FileType } from "../hooks/useApi";
import { rendererRegistry } from "../renderers/registry";
import type { TocHeading, RendererProps } from "../renderers/registry";
import { TocToggle } from "./TocToggle";
import { RawToggle } from "./RawToggle";
import { CopyButton } from "./CopyButton";
import { CloseFileButton } from "./CloseFileButton";

interface FileViewerProps {
  fileId: string;
  fileName: string;
  fileType: FileType;
  revision: number;
  onFileOpened: (fileId: string) => void;
  onHeadingsChange: (headings: TocHeading[]) => void;
  onContentRendered?: () => void;
  isTocOpen: boolean;
  onTocToggle: () => void;
  onRemoveFile: () => void;
  isWide: boolean;
}

export function FileViewer({
  fileId,
  fileName,
  fileType,
  revision,
  onFileOpened,
  onHeadingsChange,
  onContentRendered,
  isTocOpen,
  onTocToggle,
  onRemoveFile,
  isWide,
}: FileViewerProps) {
  const entry = rendererRegistry[fileType] ?? rendererRegistry["unknown"];
  const { features, contentSource } = entry;
  const Component = entry.component;

  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [isRawView, setIsRawView] = useState(false);

  // Fetch text content for text-based renderers.
  useEffect(() => {
    if (contentSource !== "text") {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchFileContent(fileId)
      .then((data) => {
        if (!cancelled) {
          setContent(data.content);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent("Failed to load file.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, revision, contentSource]);

  // Clear headings for non-heading file types.
  useEffect(() => {
    if (!features.headings) {
      onHeadingsChange([]);
    }
  }, [features.headings, onHeadingsChange]);

  // Reset raw view when switching files.
  useEffect(() => {
    setIsRawView(false);
  }, [fileId]);

  if (loading && contentSource === "text") {
    return (
      <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
        Loading...
      </div>
    );
  }

  // Build renderer props based on content source.
  const baseProps = {
    fileId,
    fileName,
    revision,
    isRawView,
    onFileOpened,
    onHeadingsChange,
    onContentRendered,
  };

  const rendererProps: RendererProps =
    contentSource === "text"
      ? { ...baseProps, contentSource: "text" as const, content }
      : {
          ...baseProps,
          contentSource: "raw" as const,
          rawUrl: rawFileUrl(fileId, revision),
        };

  return (
    <div className="flex items-start gap-2">
      <article className={`markdown-body min-w-0 flex-1${isWide ? " markdown-body--wide" : ""}`}>
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
      <div className="shrink-0 flex flex-col gap-2 -mr-4 -mt-4">
        {features.toc && <TocToggle isTocOpen={isTocOpen} onToggle={onTocToggle} />}
        {features.raw && <RawToggle isRaw={isRawView} onToggle={() => setIsRawView((v) => !v)} />}
        {features.copyable && <CopyButton content={content} />}
        <CloseFileButton onClose={onRemoveFile} />
      </div>
    </div>
  );
}
