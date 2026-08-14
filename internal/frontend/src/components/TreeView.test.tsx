import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TreeView } from "./TreeView";
import type { FileEntry, Group } from "../hooks/useApi";

function makeFile(overrides: Partial<FileEntry>): FileEntry {
  return {
    name: overrides.name ?? "x.md",
    id: overrides.id ?? "id-" + Math.random().toString(36).slice(2, 8),
    path: overrides.path ?? "/x.md",
    type: "markdown",
    ...overrides,
  };
}

function harness(opts: {
  files: FileEntry[];
  activeGroup?: string;
  activeFileId?: string | null;
  showTitle?: boolean;
  menuOpenId?: string | null;
  otherGroups?: Group[];
  onFileSelect?: ReturnType<typeof vi.fn>;
  onMenuToggle?: ReturnType<typeof vi.fn>;
  onOpenInNewTab?: ReturnType<typeof vi.fn>;
  onCopyPath?: ReturnType<typeof vi.fn>;
  onCopyLink?: ReturnType<typeof vi.fn>;
  onMoveToGroup?: ReturnType<typeof vi.fn>;
  onRemove?: ReturnType<typeof vi.fn>;
}) {
  const onFileSelect = opts.onFileSelect ?? vi.fn();
  const onMenuToggle = opts.onMenuToggle ?? vi.fn();

  function Wrapper() {
    const menuRef = useRef<HTMLDivElement>(null);
    return (
      <TreeView
        files={opts.files}
        activeGroup={opts.activeGroup ?? "default"}
        activeFileId={opts.activeFileId ?? null}
        showTitle={opts.showTitle ?? false}
        menuOpenId={opts.menuOpenId ?? null}
        otherGroups={opts.otherGroups ?? []}
        onFileSelect={onFileSelect as unknown as (id: string) => void}
        onMenuToggle={onMenuToggle as unknown as (id: string) => void}
        onOpenInNewTab={(opts.onOpenInNewTab ?? vi.fn()) as unknown as (id: string) => void}
        onCopyPath={(opts.onCopyPath ?? vi.fn()) as unknown as (path: string) => void}
        onCopyLink={(opts.onCopyLink ?? vi.fn()) as unknown as (id: string) => void}
        onMoveToGroup={
          (opts.onMoveToGroup ?? vi.fn()) as unknown as (id: string, group: string) => void
        }
        onRemove={(opts.onRemove ?? vi.fn()) as unknown as (id: string) => void}
        menuRef={menuRef}
      />
    );
  }

  return { onFileSelect, onMenuToggle, ...render(<Wrapper />) };
}

// Build a file set that guarantees a directory level in the tree. The
// common-prefix removal in buildTree pulls up shared parents, so we use
// files in distinct parent directories.
function filesAcrossTwoDirs() {
  return [
    makeFile({ id: "a", path: "/proj/docs/api.md", name: "api.md" }),
    makeFile({ id: "b", path: "/proj/docs/intro.md", name: "intro.md" }),
    makeFile({ id: "c", path: "/proj/spec/v1.md", name: "v1.md" }),
  ];
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TreeView", () => {
  it("renders flat files at top level when there is no directory nesting", () => {
    const files = [
      makeFile({ id: "a", name: "alpha.md", path: "/p/alpha.md" }),
      makeFile({ id: "b", name: "beta.md", path: "/p/beta.md" }),
    ];
    harness({ files });
    expect(screen.getByText("alpha.md")).toBeInTheDocument();
    expect(screen.getByText("beta.md")).toBeInTheDocument();
  });

  it("renders directory nodes for files in different subdirectories", () => {
    harness({ files: filesAcrossTwoDirs() });
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.getByText("spec")).toBeInTheDocument();
  });

  it("calls onFileSelect when a file row is clicked", async () => {
    const onFileSelect = vi.fn();
    const files = [makeFile({ id: "id1", path: "/x/a.md", name: "a.md" })];
    const user = userEvent.setup();
    harness({ files, onFileSelect });

    await user.click(screen.getByText("a.md"));
    expect(onFileSelect).toHaveBeenCalledWith("id1");
  });

  it("collapses and expands a directory when its row is clicked", async () => {
    const user = userEvent.setup();
    harness({ files: filesAcrossTwoDirs() });

    // initially: docs and spec directories visible with their children
    expect(screen.getByText("api.md")).toBeInTheDocument();
    expect(screen.getByText("intro.md")).toBeInTheDocument();

    await user.click(screen.getByText("docs"));
    expect(screen.queryByText("api.md")).not.toBeInTheDocument();
    expect(screen.queryByText("intro.md")).not.toBeInTheDocument();
    // spec directory and its children should remain visible
    expect(screen.getByText("v1.md")).toBeInTheDocument();

    await user.click(screen.getByText("docs"));
    expect(screen.getByText("api.md")).toBeInTheDocument();
  });

  it("persists collapsed state to localStorage", async () => {
    const user = userEvent.setup();
    harness({ files: filesAcrossTwoDirs() });

    await user.click(screen.getByText("docs"));

    const raw = localStorage.getItem("mo-sidebar-tree-collapsed");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.default).toContain("docs");
  });

  it("restores collapsed state from localStorage on initial render", () => {
    localStorage.setItem("mo-sidebar-tree-collapsed", JSON.stringify({ default: ["docs"] }));

    harness({ files: filesAcrossTwoDirs() });
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.queryByText("api.md")).not.toBeInTheDocument();
  });

  it("highlights the active file", () => {
    const files = [
      makeFile({ id: "active", path: "/p/active.md", name: "active.md" }),
      makeFile({ id: "other", path: "/p/other.md", name: "other.md" }),
    ];
    harness({ files, activeFileId: "active" });

    const activeLink = screen.getByText("active.md").closest("a");
    expect(activeLink).toHaveAttribute("aria-current", "page");
  });

  it("shows file title when showTitle is true and title is set", () => {
    const files = [
      makeFile({
        id: "id1",
        path: "/p/example.md",
        name: "example.md",
        title: "My Title",
      }),
    ];
    harness({ files, showTitle: true });
    expect(screen.getByText("My Title")).toBeInTheDocument();
  });

  it("recovers from malformed localStorage data", () => {
    localStorage.setItem("mo-sidebar-tree-collapsed", "not json");
    const files = [makeFile({ id: "a", path: "/p/a.md", name: "a.md" })];
    expect(() => harness({ files })).not.toThrow();
  });

  it("re-reads collapsed state when activeGroup changes", () => {
    localStorage.setItem(
      "mo-sidebar-tree-collapsed",
      JSON.stringify({ groupA: ["docs"], groupB: [] }),
    );
    const files = filesAcrossTwoDirs();

    const { rerender } = render(<TreeViewWrapped files={files} activeGroup="groupA" />);
    expect(screen.queryByText("api.md")).not.toBeInTheDocument();

    rerender(<TreeViewWrapped files={files} activeGroup="groupB" />);
    expect(screen.getByText("api.md")).toBeInTheDocument();
  });
});

function TreeViewWrapped({ files, activeGroup }: { files: FileEntry[]; activeGroup: string }) {
  const menuRef = useRef<HTMLDivElement>(null);
  return (
    <TreeView
      files={files}
      activeGroup={activeGroup}
      activeFileId={null}
      showTitle={false}
      menuOpenId={null}
      otherGroups={[]}
      onFileSelect={() => {}}
      onMenuToggle={() => {}}
      onOpenInNewTab={() => {}}
      onCopyPath={() => {}}
      onCopyLink={() => {}}
      onMoveToGroup={() => {}}
      onRemove={() => {}}
      menuRef={menuRef}
    />
  );
}
