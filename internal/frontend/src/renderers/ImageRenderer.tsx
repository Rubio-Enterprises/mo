import { useEffect } from "react";
import type { RawRendererProps } from "./registry";

export function ImageRenderer({
  fileName,
  rawUrl,
  onHeadingsChange,
  onContentRendered,
}: RawRendererProps) {
  useEffect(() => {
    onHeadingsChange([]);
  }, [onHeadingsChange]);

  return (
    <div className="flex items-center justify-center p-4">
      <img
        src={rawUrl}
        alt={fileName}
        className="max-w-full h-auto"
        onLoad={() => onContentRendered?.()}
        onError={() => onContentRendered?.()}
      />
    </div>
  );
}
