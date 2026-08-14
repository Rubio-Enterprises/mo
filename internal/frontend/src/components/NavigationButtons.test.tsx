import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavigationButtons } from "./NavigationButtons";

describe("NavigationButtons", () => {
  it("renders both buttons", () => {
    render(
      <NavigationButtons
        canGoBack={true}
        canGoForward={true}
        onBack={() => {}}
        onForward={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Go back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go forward" })).toBeInTheDocument();
  });

  it("disables the back button when canGoBack is false", () => {
    render(
      <NavigationButtons
        canGoBack={false}
        canGoForward={true}
        onBack={() => {}}
        onForward={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go forward" })).not.toBeDisabled();
  });

  it("disables the forward button when canGoForward is false", () => {
    render(
      <NavigationButtons
        canGoBack={true}
        canGoForward={false}
        onBack={() => {}}
        onForward={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled();
  });

  it("calls onBack when back button is clicked", async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(
      <NavigationButtons
        canGoBack={true}
        canGoForward={true}
        onBack={onBack}
        onForward={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("calls onForward when forward button is clicked", async () => {
    const onForward = vi.fn();
    const user = userEvent.setup();
    render(
      <NavigationButtons
        canGoBack={true}
        canGoForward={true}
        onBack={() => {}}
        onForward={onForward}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Go forward" }));
    expect(onForward).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onBack when disabled and clicked", async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(
      <NavigationButtons
        canGoBack={false}
        canGoForward={true}
        onBack={onBack}
        onForward={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(onBack).not.toHaveBeenCalled();
  });
});
