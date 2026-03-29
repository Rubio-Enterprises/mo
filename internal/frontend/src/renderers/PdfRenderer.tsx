import { useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import type { RawRendererProps } from "./registry";

// Worker file is emitted by the pdfjsWorkerPlugin in vite.config.ts.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export function PdfRenderer({ rawUrl, onHeadingsChange, onContentRendered }: RawRendererProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [error, setError] = useState<string>("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageWidth, setPageWidth] = useState<number>(800);

  const measureWidth = useCallback(() => {
    if (containerRef.current) {
      const w = containerRef.current.clientWidth;
      if (w > 0) setPageWidth(w);
    }
  }, []);

  useEffect(() => {
    measureWidth();
    const observer = new ResizeObserver(measureWidth);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [measureWidth]);

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
    <div ref={containerRef} className="flex flex-col items-center gap-4">
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
          <Page key={i + 1} pageNumber={i + 1} width={pageWidth} className="mb-4 shadow-md" />
        ))}
      </Document>
    </div>
  );
}
