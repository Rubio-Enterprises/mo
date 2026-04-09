import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { fetchFileContent, rawFileUrl } from "../hooks/useApi";
import type { FileType } from "../hooks/useApi";
import { rendererRegistry } from "../renderers/registry";
import type { TocHeading, RendererProps, CheckboxInfo } from "../renderers/registry";
import { TocToggle } from "./TocToggle";
import { RawToggle } from "./RawToggle";
import { CopyButton } from "./CopyButton";
import { CloseFileButton } from "./CloseFileButton";
import { CheckboxActionsButton } from "./CheckboxActionsButton";
import { useCheckboxSelection } from "../hooks/useCheckboxSelection";
import { SelectionActionBar } from "./SelectionActionBar";
import { batchSetCheckboxes } from "../hooks/useApi";

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
  const entry = rendererRegistry[fileType];
  const { features, contentSource } = entry;
  const Component = entry.component;

  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [isRawView, setIsRawView] = useState(false);
  const [checkboxInfo, setCheckboxInfo] = useState<CheckboxInfo | null>(null);

  const articleRef = useRef<HTMLDivElement>(null);
  const { selectedKeys, isSelected, onShiftClick, clearSelection } =
    useCheckboxSelection(articleRef);

  const onCheckboxInfo = useCallback((info: CheckboxInfo) => {
    setCheckboxInfo(info);
  }, []);

  const handleBatchCheck = useCallback(() => {
    if (!checkboxInfo) return;
    batchSetCheckboxes(fileId, selectedKeys, true).catch(() => {});
    clearSelection();
  }, [fileId, selectedKeys, clearSelection, checkboxInfo]);

  const handleBatchUncheck = useCallback(() => {
    if (!checkboxInfo) return;
    batchSetCheckboxes(fileId, selectedKeys, false).catch(() => {});
    clearSelection();
  }, [fileId, selectedKeys, clearSelection, checkboxInfo]);

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

  useEffect(() => {
    if (!features.headings) {
      onHeadingsChange([]);
    }
  }, [features.headings, onHeadingsChange]);

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

  const baseProps = {
    fileId,
    fileName,
    revision,
    isRawView,
    onFileOpened,
    onHeadingsChange,
    onContentRendered,
    onCheckboxInfo,
    onShiftClick,
    isCheckboxSelected: isSelected,
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
    <>
      <div className="flex items-start gap-2">
        <article ref={articleRef} className={`markdown-body min-w-0 flex-1${isWide ? " markdown-body--wide" : ""}`}>
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
          {checkboxInfo?.hasCheckboxes && (
              <CheckboxActionsButton
                onCheckAll={checkboxInfo.checkAll}
                onUncheckAll={checkboxInfo.uncheckAll}
              />
            )}
          <CloseFileButton onClose={onRemoveFile} />
        </div>
      </div>
      {selectedKeys.length >= 2 && checkboxInfo && (
        <SelectionActionBar
          selectedCount={selectedKeys.length}
          totalCount={checkboxInfo.totalCheckboxes}
          onCheck={handleBatchCheck}
          onUncheck={handleBatchUncheck}
          onCancel={clearSelection}
        />
      )}
    </>
  );
}
