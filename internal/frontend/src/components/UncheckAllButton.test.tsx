import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UncheckAllButton } from "./UncheckAllButton";

describe("UncheckAllButton", () => {
  it("renders with correct title", () => {
    render(<UncheckAllButton onUncheckAll={() => {}} />);
    expect(screen.getByTitle("Uncheck all checkboxes")).toBeInTheDocument();
  });

  it("has correct aria-label", () => {
    render(<UncheckAllButton onUncheckAll={() => {}} />);
    const button = screen.getByRole("button", { name: "Uncheck all checkboxes" });
    expect(button).toBeInTheDocument();
  });

  it("calls onUncheckAll when clicked", async () => {
    const user = userEvent.setup();
    const onUncheckAll = vi.fn();
    render(<UncheckAllButton onUncheckAll={onUncheckAll} />);

    await user.click(screen.getByRole("button"));
    expect(onUncheckAll).toHaveBeenCalledOnce();
  });
});
