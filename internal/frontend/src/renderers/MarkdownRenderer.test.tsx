import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Mock heavyweight deps before importing the component.
vi.mock("shiki", () => ({
  codeToHtml: vi.fn().mockResolvedValue("<pre class='shiki'>highlighted</pre>"),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg>mermaid</svg>" }),
  },
}));

vi.mock("../hooks/useApi", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useApi")>("../hooks/useApi");
  return {
    ...actual,
    openRelativeFile: vi.fn(),
    fetchCheckboxes: vi.fn().mockResolvedValue({
      sources: {},
      overrides: {},
      orderedKeys: [],
    }),
    toggleCheckbox: vi.fn().mockResolvedValue(undefined),
    uncheckAllCheckboxes: vi.fn().mockResolvedValue(undefined),
    checkAllCheckboxes: vi.fn().mockResolvedValue(undefined),
  };
});

import { MarkdownRenderer } from "./MarkdownRenderer";

const baseProps = {
  fileId: "abc12345",
  fileName: "README.md",
  revision: 1,
  isRawView: false,
  onHeadingsChange: vi.fn(),
  contentSource: "text" as const,
};

beforeEach(() => {
  // Provide a non-null baseDir for relative link resolution.
  (baseProps.onHeadingsChange as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MarkdownRenderer", () => {
  it("renders a basic heading", async () => {
    render(<MarkdownRenderer {...baseProps} content={"# Hello world"} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Hello world" })).toBeInTheDocument();
    });
  });

  it("emits headings via onHeadingsChange", async () => {
    const onHeadingsChange = vi.fn();
    render(
      <MarkdownRenderer
        {...baseProps}
        onHeadingsChange={onHeadingsChange}
        content={"# A\n\n## B"}
      />,
    );
    await waitFor(() => {
      expect(onHeadingsChange).toHaveBeenCalled();
    });
    const last = onHeadingsChange.mock.calls.at(-1)?.[0];
    expect(Array.isArray(last)).toBe(true);
    expect(last.some((h: { text: string }) => h.text === "A")).toBe(true);
    expect(last.some((h: { text: string }) => h.text === "B")).toBe(true);
  });

  it("strips YAML frontmatter and renders it as a metadata block", async () => {
    const content = `---\ntitle: Doc\nauthor: alice\n---\n\n# Body`;
    render(<MarkdownRenderer {...baseProps} content={content} />);
    await waitFor(() => {
      expect(screen.getByText("Metadata")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Body" })).toBeInTheDocument();
    });
  });

  it("renders paragraph content", async () => {
    render(<MarkdownRenderer {...baseProps} content={"Just a paragraph with **bold** text."} />);
    await waitFor(() => {
      expect(screen.getByText(/Just a paragraph/i)).toBeInTheDocument();
    });
  });

  it("switches to raw view when isRawView is true", async () => {
    const { container } = render(
      <MarkdownRenderer {...baseProps} isRawView={true} content={"# Visible\n\nRaw view body"} />,
    );
    // In raw view, content is shown highlighted as plain text — the heading
    // text should not become an <h1> element.
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Visible" })).not.toBeInTheDocument();
    });
    // Positive assertion: raw view should route through shiki (mocked to a
    // <pre class="shiki"> element), so confirm the highlighted block rendered.
    await waitFor(() => {
      expect(container.querySelector("pre.shiki")).toBeInTheDocument();
    });
  });

  it("calls onContentRendered when rendering completes", async () => {
    const onContentRendered = vi.fn();
    render(
      <MarkdownRenderer {...baseProps} onContentRendered={onContentRendered} content={"# Hello"} />,
    );
    await waitFor(() => expect(onContentRendered).toHaveBeenCalled());
  });
});
