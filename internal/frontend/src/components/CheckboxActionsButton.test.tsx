import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CheckboxActionsButton } from "./CheckboxActionsButton";

describe("CheckboxActionsButton", () => {
  it("renders with correct aria-label", () => {
    render(<CheckboxActionsButton onCheckAll={() => {}} onUncheckAll={() => {}} />);
    expect(screen.getByRole("button", { name: "Checkbox actions" })).toBeInTheDocument();
  });

  it("opens dropdown when clicked", async () => {
    const user = userEvent.setup();
    render(<CheckboxActionsButton onCheckAll={() => {}} onUncheckAll={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Checkbox actions" }));
    expect(screen.getByText("Check all")).toBeInTheDocument();
    expect(screen.getByText("Uncheck all")).toBeInTheDocument();
  });

  it("calls onCheckAll when Check all is clicked", async () => {
    const user = userEvent.setup();
    const onCheckAll = vi.fn();
    render(<CheckboxActionsButton onCheckAll={onCheckAll} onUncheckAll={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Checkbox actions" }));
    await user.click(screen.getByText("Check all"));
    expect(onCheckAll).toHaveBeenCalledOnce();
  });

  it("calls onUncheckAll when Uncheck all is clicked", async () => {
    const user = userEvent.setup();
    const onUncheckAll = vi.fn();
    render(<CheckboxActionsButton onCheckAll={() => {}} onUncheckAll={onUncheckAll} />);

    await user.click(screen.getByRole("button", { name: "Checkbox actions" }));
    await user.click(screen.getByText("Uncheck all"));
    expect(onUncheckAll).toHaveBeenCalledOnce();
  });

  it("closes dropdown after action", async () => {
    const user = userEvent.setup();
    render(<CheckboxActionsButton onCheckAll={() => {}} onUncheckAll={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Checkbox actions" }));
    await user.click(screen.getByText("Check all"));
    expect(screen.queryByText("Check all")).not.toBeInTheDocument();
  });
});
