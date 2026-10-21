import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileContextMenu } from "./FileContextMenu";
import type { FileEntry } from "../hooks/useApi";

const file: FileEntry = { id: "aaa11111", name: "a.md", path: "/a.md" };

function renderMenu(isOpen: boolean, onToggle = vi.fn()) {
  render(
    <FileContextMenu
      file={file}
      isOpen={isOpen}
      otherGroups={[]}
      onToggle={onToggle}
      onOpenInNewTab={() => {}}
      onCopyPath={() => {}}
      onCopyLink={() => {}}
      onMoveToGroup={() => {}}
      onRemove={() => {}}
      menuRef={createRef<HTMLDivElement>()}
    />,
  );
  return onToggle;
}

describe("FileContextMenu", () => {
  it("closes on Escape and returns focus to the toggle", async () => {
    const onToggle = renderMenu(true);
    screen.getByText("Copy link").focus();

    await userEvent.keyboard("{Escape}");

    expect(onToggle).toHaveBeenCalledWith("aaa11111");
    expect(screen.getByRole("button", { name: "More actions" })).toHaveFocus();
  });

  it("ignores Escape while closed", async () => {
    const onToggle = renderMenu(false);

    await userEvent.keyboard("{Escape}");

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("ignores other keys while open", async () => {
    const onToggle = renderMenu(true);

    await userEvent.keyboard("{Enter}");

    expect(onToggle).not.toHaveBeenCalled();
  });
});
