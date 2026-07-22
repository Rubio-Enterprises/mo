import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewModeToggle } from "./ViewModeToggle";

describe("ViewModeToggle", () => {
  it("renders flat view with aria-pressed=false", () => {
    render(<ViewModeToggle viewMode="flat" onToggle={() => {}} />);
    const btn = screen.getByRole("button", { name: "Tree view" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("title")).toBe("Switch to tree view");
  });

  it("renders tree view with aria-pressed=true", () => {
    render(<ViewModeToggle viewMode="tree" onToggle={() => {}} />);
    const btn = screen.getByRole("button", { name: "Tree view" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("title")).toBe("Switch to flat view");
  });

  it("invokes onToggle on click", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<ViewModeToggle viewMode="flat" onToggle={onToggle} />);
    await user.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
