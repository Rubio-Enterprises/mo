import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FileViewer } from "./FileViewer";

// Mock the API module.
vi.mock("../hooks/useApi", async () => {
  const actual = await vi.importActual("../hooks/useApi");
  return {
    ...actual,
    fetchFileContent: vi.fn().mockResolvedValue({
      content: "# Test Content",
      baseDir: "/test",
    }),
  };
});

// Mock the renderers to simple stubs.
vi.mock("../renderers/registry", () => {
  function StubRenderer(props: { contentSource: string; content?: string; rawUrl?: string }) {
    if (props.contentSource === "text") {
      return <div data-testid="text-renderer">{props.content}</div>;
    }
    return <div data-testid="raw-renderer">{props.rawUrl}</div>;
  }

  return {
    rendererRegistry: {
      markdown: {
        component: StubRenderer,
        features: { toc: true, raw: true, headings: true, copyable: true },
        contentSource: "text",
      },
      code: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: true },
        contentSource: "text",
      },
      pdf: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: false },
        contentSource: "raw",
      },
      image: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: false },
        contentSource: "raw",
      },
      binary: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: false },
        contentSource: "raw",
      },
      unknown: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: true },
        contentSource: "text",
      },
    },
  };
});

const defaultProps = {
  activeGroup: "default",
  fileId: "abc123",
  fileName: "test.md",
  fileType: "markdown" as const,
  revision: 1,
  onFileOpened: vi.fn(),
  onHeadingsChange: vi.fn(),
  onContentRendered: vi.fn(),
  isTocOpen: false,
  onTocToggle: vi.fn(),
  onRemoveFile: vi.fn(),
  isWide: false,
  fontSize: "medium" as const,
};

describe("FileViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders text renderer for markdown type", async () => {
    render(<FileViewer {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("text-renderer")).toBeInTheDocument();
    });
  });

  it("renders raw renderer for pdf type", async () => {
    render(<FileViewer {...defaultProps} fileType="pdf" fileName="doc.pdf" />);
    await waitFor(() => {
      const el = screen.getByTestId("raw-renderer");
      expect(el).toBeInTheDocument();
      expect(el.textContent).toContain("/_/api/groups/default/files/abc123/raw?v=1");
    });
  });

  it("clears headings for non-heading file types", async () => {
    render(<FileViewer {...defaultProps} fileType="pdf" fileName="doc.pdf" />);
    await waitFor(() => {
      expect(defaultProps.onHeadingsChange).toHaveBeenCalledWith([]);
    });
  });
});
