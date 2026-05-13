import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TitleToggle } from "./TitleToggle";

describe("TitleToggle", () => {
  it("renders with showTitle=false and announces correct title", () => {
    render(<TitleToggle showTitle={false} onToggle={() => {}} />);
    const btn = screen.getByRole("button", { name: "Title display" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("title")).toBe("Show heading titles");
  });

  it("renders with showTitle=true and switches title text", () => {
    render(<TitleToggle showTitle={true} onToggle={() => {}} />);
    const btn = screen.getByRole("button", { name: "Title display" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("title")).toBe("Show file names");
  });

  it("calls onToggle on click", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<TitleToggle showTitle={false} onToggle={onToggle} />);
    await user.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
