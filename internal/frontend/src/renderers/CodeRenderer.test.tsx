import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Mock shiki BEFORE importing the component under test.
vi.mock("shiki", () => ({
  codeToHtml: vi.fn(),
}));

import { codeToHtml } from "shiki";
import { CodeRenderer } from "./CodeRenderer";

const baseProps = {
  fileId: "abc12345",
  fileName: "example.ts",
  revision: 1,
  isRawView: false,
  onHeadingsChange: vi.fn(),
  contentSource: "text" as const,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CodeRenderer", () => {
  it("renders fallback <pre> when shiki has not yet returned", () => {
    (codeToHtml as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));

    render(<CodeRenderer {...baseProps} content="console.log('hi')" />);
    expect(screen.getByText("console.log('hi')")).toBeInTheDocument();
  });

  it("renders shiki output when codeToHtml resolves", async () => {
    (codeToHtml as ReturnType<typeof vi.fn>).mockResolvedValue("<pre class='shiki'>OK</pre>");

    const { container } = render(<CodeRenderer {...baseProps} content="ok" />);

    await waitFor(() => {
      expect(container.querySelector("pre.shiki")).toBeTruthy();
    });
  });

  it("calls onContentRendered after content updates", async () => {
    (codeToHtml as ReturnType<typeof vi.fn>).mockResolvedValue("<pre>X</pre>");
    const onContentRendered = vi.fn();

    render(<CodeRenderer {...baseProps} content="x" onContentRendered={onContentRendered} />);

    await waitFor(() => expect(onContentRendered).toHaveBeenCalled());
  });

  it("falls back to plain <pre> when shiki rejects", async () => {
    (codeToHtml as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no lang"));

    render(<CodeRenderer {...baseProps} content="raw text" />);

    await waitFor(() => {
      // Plain fallback should still display content.
      expect(screen.getByText("raw text")).toBeInTheDocument();
    });
  });
});
