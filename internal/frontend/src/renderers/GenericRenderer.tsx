import { useEffect } from "react";
import type { RawRendererProps } from "./registry";

export function GenericRenderer({
  fileName,
  rawUrl,
  onHeadingsChange,
  onContentRendered,
}: RawRendererProps) {
  useEffect(() => {
    onHeadingsChange([]);
  }, [onHeadingsChange]);

  useEffect(() => {
    onContentRendered?.();
  }, [onContentRendered]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-gh-text-secondary">
      <div className="text-4xl">📄</div>
      <div className="text-lg font-medium text-gh-text-primary">{fileName}</div>
      <div className="text-sm">This file appears to be binary and cannot be previewed.</div>
      <a
        href={rawUrl}
        download={fileName}
        className="mt-2 px-4 py-2 bg-gh-bg-sidebar border border-gh-border rounded-md text-gh-text-primary text-sm hover:bg-gh-bg-tertiary"
      >
        Download file
      </a>
    </div>
  );
}
