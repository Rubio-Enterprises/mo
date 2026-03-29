import { useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import type { RawRendererProps } from "./registry";

// Configure pdf.js worker — loaded only when this module is imported (lazy).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export function PdfRenderer({ rawUrl, onHeadingsChange, onContentRendered }: RawRendererProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [error, setError] = useState<string>("");

  // PDF has no headings.
  useEffect(() => {
    onHeadingsChange([]);
  }, [onHeadingsChange]);

  function onDocumentLoadSuccess(pdf: { numPages: number }) {
    setNumPages(pdf.numPages);
    setError("");
    onContentRendered?.();
  }

  function onDocumentLoadError(err: Error) {
    setError(`Failed to load PDF: ${err.message}`);
    onContentRendered?.();
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <Document
        file={rawUrl}
        onLoadSuccess={onDocumentLoadSuccess}
        onLoadError={onDocumentLoadError}
        loading={
          <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
            Loading PDF...
          </div>
        }
      >
        {Array.from({ length: numPages }, (_, i) => (
          <Page key={i + 1} pageNumber={i + 1} width={800} className="mb-4 shadow-md" />
        ))}
      </Document>
    </div>
  );
}
