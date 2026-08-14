import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageRenderer } from "./ImageRenderer";

describe("ImageRenderer", () => {
  const baseProps = {
    activeGroup: "default",
    fileId: "abc12345",
    fileName: "photo.png",
    revision: 1,
    isRawView: false,
    onHeadingsChange: vi.fn(),
    fontSize: "medium" as const,
    contentSource: "raw" as const,
    rawUrl: "/_/api/files/abc12345/raw",
  };

  it("renders an img with src and alt", () => {
    render(<ImageRenderer {...baseProps} />);
    const img = screen.getByAltText("photo.png") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(baseProps.rawUrl);
  });

  it("invokes onContentRendered on load", () => {
    const onContentRendered = vi.fn();
    render(<ImageRenderer {...baseProps} onContentRendered={onContentRendered} />);
    const img = screen.getByAltText("photo.png");
    fireEvent.load(img);
    expect(onContentRendered).toHaveBeenCalledTimes(1);
  });

  it("invokes onContentRendered on error", () => {
    const onContentRendered = vi.fn();
    render(<ImageRenderer {...baseProps} onContentRendered={onContentRendered} />);
    const img = screen.getByAltText("photo.png");
    fireEvent.error(img);
    expect(onContentRendered).toHaveBeenCalledTimes(1);
  });

  it("does not throw if onContentRendered is missing", () => {
    render(<ImageRenderer {...baseProps} />);
    expect(() => fireEvent.load(screen.getByAltText("photo.png"))).not.toThrow();
  });
});
