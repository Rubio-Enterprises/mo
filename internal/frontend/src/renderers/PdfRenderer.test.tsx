import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";

// Mock react-pdf since jsdom lacks canvas and Web Worker support.
vi.mock("react-pdf", () => ({
  Document: ({
    onLoadSuccess,
    children,
  }: {
    file: string;
    onLoadSuccess: (pdf: { numPages: number }) => void;
    children: React.ReactNode;
    loading: React.ReactNode;
  }) => {
    // Simulate async load.
    setTimeout(() => onLoadSuccess({ numPages: 3 }), 0);
    return <div data-testid="pdf-document">{children}</div>;
  },
  Page: ({ pageNumber }: { pageNumber: number }) => (
    <div data-testid={`pdf-page-${pageNumber}`}>Page {pageNumber}</div>
  ),
  pdfjs: {
    GlobalWorkerOptions: { workerSrc: "" },
  },
}));

// Dynamic import for the lazy-loaded component.
const { PdfRenderer } = await import("./PdfRenderer");

describe("PdfRenderer", () => {
  const defaultProps = {
    fileId: "abc123",
    fileName: "doc.pdf",
    revision: 1,
    isRawView: false,
    onHeadingsChange: vi.fn(),
    onContentRendered: vi.fn(),
    contentSource: "raw" as const,
    rawUrl: "/_/api/files/abc123/raw?v=1",
  };

  it("renders PDF document with pages", async () => {
    render(
      <Suspense fallback={<div>Loading...</div>}>
        <PdfRenderer {...defaultProps} />
      </Suspense>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("pdf-document")).toBeInTheDocument();
    });
  });

  it("displays page count after load", async () => {
    render(
      <Suspense fallback={<div>Loading...</div>}>
        <PdfRenderer {...defaultProps} />
      </Suspense>,
    );

    await waitFor(() => {
      // After onLoadSuccess fires with numPages: 3, pages should render.
      expect(screen.getByTestId("pdf-page-1")).toBeInTheDocument();
    });
  });

  it("clears headings on mount", async () => {
    render(
      <Suspense fallback={<div>Loading...</div>}>
        <PdfRenderer {...defaultProps} />
      </Suspense>,
    );

    await waitFor(() => {
      expect(defaultProps.onHeadingsChange).toHaveBeenCalledWith([]);
    });
  });
});
