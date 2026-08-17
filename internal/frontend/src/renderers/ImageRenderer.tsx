import type { RawRendererProps } from "./registry";

export function ImageRenderer({ fileName, rawUrl, onContentRendered }: RawRendererProps) {
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
