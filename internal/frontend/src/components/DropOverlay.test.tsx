import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DropOverlay } from "./DropOverlay";

describe("DropOverlay", () => {
  it("renders the drop hint text", () => {
    render(<DropOverlay />);
    expect(screen.getByText("Drop Markdown files here")).toBeInTheDocument();
  });

  it("renders as a non-interactive overlay", () => {
    const { container } = render(<DropOverlay />);
    const overlay = container.firstChild as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.className).toContain("pointer-events-none");
    expect(overlay.className).toContain("fixed");
  });
});
