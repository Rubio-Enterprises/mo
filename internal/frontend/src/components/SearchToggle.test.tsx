import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchToggle } from "./SearchToggle";

describe("SearchToggle", () => {
  it("renders with closed state", () => {
    render(<SearchToggle isOpen={false} onToggle={() => {}} />);
    const btn = screen.getByRole("button", { name: "Search" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("title")).toBe("Search files");
  });

  it("renders with open state and exposes aria-expanded", () => {
    render(<SearchToggle isOpen={true} onToggle={() => {}} />);
    const btn = screen.getByRole("button", { name: "Search" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.getAttribute("title")).toBe("Close search");
  });

  it("calls onToggle when clicked", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<SearchToggle isOpen={false} onToggle={onToggle} />);

    await user.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
