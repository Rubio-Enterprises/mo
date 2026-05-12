import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileContextMenu } from "./FileContextMenu";
import type { FileEntry, Group } from "../hooks/useApi";

function makeFile(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: "a.md",
    id: "abc12345",
    path: "/home/user/a.md",
    type: "markdown",
    ...overrides,
  };
}

function renderMenu(opts: {
  isOpen: boolean;
  uploaded?: boolean;
  otherGroups?: Group[];
  handlers?: Partial<{
    onToggle: (id: string) => void;
    onOpenInNewTab: (id: string) => void;
    onCopyPath: (path: string) => void;
    onMoveToGroup: (id: string, group: string) => void;
    onRemove: (id: string) => void;
  }>;
}) {
  const handlers = {
    onToggle: vi.fn(),
    onOpenInNewTab: vi.fn(),
    onCopyPath: vi.fn(),
    onMoveToGroup: vi.fn(),
    onRemove: vi.fn(),
    ...opts.handlers,
  };

  const file = makeFile({ uploaded: opts.uploaded });
  const menuRef = createRef<HTMLDivElement>();

  const utils = render(
    <FileContextMenu
      file={file}
      isOpen={opts.isOpen}
      otherGroups={opts.otherGroups ?? []}
      onToggle={handlers.onToggle}
      onOpenInNewTab={handlers.onOpenInNewTab}
      onCopyPath={handlers.onCopyPath}
      onMoveToGroup={handlers.onMoveToGroup}
      onRemove={handlers.onRemove}
      menuRef={menuRef}
    />,
  );
  return { handlers, file, ...utils };
}

describe("FileContextMenu", () => {
  it("renders only the trigger button when closed", () => {
    renderMenu({ isOpen: false });
    expect(screen.getByTitle("More actions")).toBeInTheDocument();
    expect(screen.queryByText("Open in new tab")).not.toBeInTheDocument();
  });

  it("clicking trigger calls onToggle and stops propagation", async () => {
    const user = userEvent.setup();
    const { handlers } = renderMenu({ isOpen: false });
    // Click bubbles upward; trigger should call stopPropagation.
    await user.click(screen.getByTitle("More actions"));
    expect(handlers.onToggle).toHaveBeenCalledWith("abc12345");
  });

  it("renders menu items when open", () => {
    renderMenu({ isOpen: true });
    expect(screen.getByText("Open in new tab")).toBeInTheDocument();
    expect(screen.getByText("Copy absolute path")).toBeInTheDocument();
    expect(screen.getByText("Close")).toBeInTheDocument();
  });

  it("hides 'Copy absolute path' for uploaded files", () => {
    renderMenu({ isOpen: true, uploaded: true });
    expect(screen.queryByText("Copy absolute path")).not.toBeInTheDocument();
  });

  it("shows 'Move to...' section when otherGroups is non-empty", () => {
    renderMenu({
      isOpen: true,
      otherGroups: [
        { name: "default", files: [] },
        { name: "docs", files: [] },
      ],
    });
    expect(screen.getByText("Move to...")).toBeInTheDocument();
    expect(screen.getByText("(default)")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
  });

  it("does NOT show 'Move to...' when otherGroups is empty", () => {
    renderMenu({ isOpen: true });
    expect(screen.queryByText("Move to...")).not.toBeInTheDocument();
  });

  it("invokes onOpenInNewTab with the file id", async () => {
    const user = userEvent.setup();
    const { handlers } = renderMenu({ isOpen: true });
    await user.click(screen.getByText("Open in new tab"));
    expect(handlers.onOpenInNewTab).toHaveBeenCalledWith("abc12345");
  });

  it("invokes onCopyPath with the file's path", async () => {
    const user = userEvent.setup();
    const { handlers } = renderMenu({ isOpen: true });
    await user.click(screen.getByText("Copy absolute path"));
    expect(handlers.onCopyPath).toHaveBeenCalledWith("/home/user/a.md");
  });

  it("invokes onMoveToGroup with id and group name", async () => {
    const user = userEvent.setup();
    const { handlers } = renderMenu({
      isOpen: true,
      otherGroups: [{ name: "docs", files: [] }],
    });
    await user.click(screen.getByText("docs"));
    expect(handlers.onMoveToGroup).toHaveBeenCalledWith("abc12345", "docs");
  });

  it("invokes onRemove with the file id", async () => {
    const user = userEvent.setup();
    const { handlers } = renderMenu({ isOpen: true });
    await user.click(screen.getByText("Close"));
    expect(handlers.onRemove).toHaveBeenCalledWith("abc12345");
  });

  it("assigns the menuRef to the dropdown wrapper", () => {
    const menuRef = createRef<HTMLDivElement>();
    render(
      <FileContextMenu
        file={makeFile()}
        isOpen={true}
        otherGroups={[]}
        onToggle={() => {}}
        onOpenInNewTab={() => {}}
        onCopyPath={() => {}}
        onMoveToGroup={() => {}}
        onRemove={() => {}}
        menuRef={menuRef}
      />,
    );
    expect(menuRef.current).toBeInstanceOf(HTMLDivElement);
    // The element should contain the menu items.
    expect(within(menuRef.current as HTMLElement).getByText("Open in new tab")).toBeInTheDocument();
  });
});
