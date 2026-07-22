import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GenericRenderer } from "./GenericRenderer";

describe("GenericRenderer", () => {
  const defaultProps = {
    activeGroup: "default",
    fileId: "abc123",
    fileName: "archive.zip",
    revision: 1,
    isRawView: false,
    onHeadingsChange: vi.fn(),
    fontSize: "medium" as const,
    onContentRendered: vi.fn(),
    contentSource: "raw" as const,
    rawUrl: "/_/api/files/abc123/raw?v=1",
  };

  it("displays file name", () => {
    render(<GenericRenderer {...defaultProps} />);
    expect(screen.getByText("archive.zip")).toBeInTheDocument();
  });

  it("renders download link with raw URL", () => {
    render(<GenericRenderer {...defaultProps} />);
    const link = screen.getByRole("link", { name: /download/i });
    expect(link).toHaveAttribute("href", "/_/api/files/abc123/raw?v=1");
  });
});
