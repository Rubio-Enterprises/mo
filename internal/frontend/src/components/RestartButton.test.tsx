import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RestartButton } from "./RestartButton";

describe("RestartButton", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // jsdom marks window.location.reload as non-configurable, so spyOn fails
    // directly. Replace window.location with a stubbed proxy that delegates
    // everything but reload, which becomes a mock fn. unstubGlobals: true in
    // vite.config.ts auto-restores window.location after each test.
    const realLocation = window.location;
    vi.stubGlobal("location", {
      ...Object.fromEntries(
        ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]
          .map((k) => [k, realLocation[k as keyof Location]]),
      ),
      reload: vi.fn(),
      assign: vi.fn(),
      replace: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => handler(url, init)),
    );
  }

  it("renders the restart button with the default title", () => {
    mockFetch(() => Promise.reject(new Error("no network")));
    render(<RestartButton />);
    const btn = screen.getByRole("button");
    expect(btn).not.toBeDisabled();
  });

  it("shows version info in title once fetched", async () => {
    mockFetch(async (url) => {
      if (url === "/_/api/version") {
        return new Response(JSON.stringify({ version: "v1.0.0", revision: "abc1234" }), {
          status: 200,
        });
      }
      return new Response(null, { status: 404 });
    });

    render(<RestartButton />);
    await waitFor(() => {
      const btn = screen.getByRole("button");
      expect(btn.getAttribute("title")).toContain("mo v1.0.0");
      expect(btn.getAttribute("title")).toContain("abc1234");
    });
  });

  it("shows restarting overlay after click and disables the button", async () => {
    mockFetch(async (url) => {
      if (url === "/_/api/version") {
        return new Response(JSON.stringify({ version: "v1.0.0", revision: "abc1234" }), {
          status: 200,
        });
      }
      if (url === "/_/api/restart") {
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 404 });
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
    render(<RestartButton />);
    await user.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText("Restarting...")).toBeInTheDocument();
    });
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("does not crash when restart fails", async () => {
    mockFetch(async (url) => {
      if (url === "/_/api/restart") {
        throw new Error("connection closed");
      }
      return new Response(null, { status: 404 });
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
    render(<RestartButton />);
    await user.click(screen.getByRole("button"));

    // Button should still be disabled (restarting state) without crashing
    await waitFor(() => {
      expect(screen.getByRole("button")).toBeDisabled();
    });
  });

  it("polls fetchVersion until success then reloads", async () => {
    let restartCalled = false;
    let versionCalls = 0;
    mockFetch(async (url) => {
      if (url === "/_/api/restart") {
        restartCalled = true;
        return new Response(null, { status: 202 });
      }
      if (url === "/_/api/version") {
        versionCalls++;
        // Fail the first two version calls (initial + 1 poll), then succeed.
        if (versionCalls > 2) {
          return new Response(JSON.stringify({ version: "v2", revision: "def" }), { status: 200 });
        }
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 404 });
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
    render(<RestartButton />);
    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(restartCalled).toBe(true));

    // Advance through poll cycles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());
  });
});
