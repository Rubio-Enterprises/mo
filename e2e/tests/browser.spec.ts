/**
 * Browser-driven E2E tests against the mo SPA.
 *
 * Covers user-facing flows that don't rely on sidebar visibility (which can
 * be collapsed on narrow viewports or via persisted state).
 */

import { test, expect, testdata } from "./fixtures";

test.describe("mo SPA in the browser", () => {
  test("loads the default group and renders the initial file", async ({ moServer, page }) => {
    await page.goto(moServer.baseURL);
    await expect(page.getByRole("heading", { name: "Initial" })).toBeVisible();
    await expect(page.getByText("This file is added at startup.")).toBeVisible();
  });

  test("switching files updates the rendered content", async ({ moServer, page }) => {
    const added = await moServer.addFile(testdata("basic.md"));

    // Deep-link directly so we don't need the sidebar to be visible.
    await page.goto(`${moServer.baseURL}/?file=${added.id}`);
    await expect(page.getByRole("heading", { name: "Basic Markdown" })).toBeVisible();
  });

  test("SSE update triggers auto-select of newly added file", async ({
    moServer,
    page,
  }) => {
    await page.goto(moServer.baseURL);
    await expect(page.getByRole("heading", { name: "Initial" })).toBeVisible();

    // Add a file via the HTTP API. The running page should observe the SSE
    // 'update' event, refresh its in-memory group list, and (per
    // App.tsx#loadGroups) auto-select the newly-added file because it is the
    // only new entry in the currently-active group. We first confirm via
    // /_/api/groups that the server-side state reflects the new entry, then
    // assert that the SPA's rendered content has switched to the new file
    // without any explicit navigation from the test.
    const added = await moServer.addFile(testdata("lists.md"));

    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${moServer.baseURL}/_/api/groups`);
          const groups = (await res.json()) as Array<{
            name: string;
            files: Array<{ id: string }>;
          }>;
          const def = groups.find((g) => g.name === "default");
          return def?.files.some((f) => f.id === added.id) ?? false;
        },
        { timeout: 5_000 },
      )
      .toBe(true);

    // The SPA's SSE 'update' handler should auto-select the newly-added file
    // (it is the only new entry in the active 'default' group), so the H1
    // from lists.md ("Lists") should appear without any test-driven navigation.
    await expect(page.getByRole("heading", { name: /^Lists$/ })).toBeVisible();
  });

  test("theme toggle switches the html data-theme attribute", async ({ moServer, page }) => {
    await page.goto(moServer.baseURL);
    await expect(page.getByRole("heading", { name: "Initial" })).toBeVisible();

    // The theme toggle is labelled "Dark mode" / "Light mode" depending on state.
    const themeToggle = page.getByRole("button", { name: /(dark|light) mode/i });
    await expect(themeToggle).toBeVisible();

    const initial = await page.locator("html").getAttribute("data-theme");
    await themeToggle.click();
    await expect
      .poll(async () => page.locator("html").getAttribute("data-theme"), { timeout: 2_000 })
      .not.toBe(initial);
  });

  test("deep link with ?file=ID navigates to that file", async ({ moServer, page }) => {
    const added = await moServer.addFile(testdata("gfm.md"));
    await page.goto(`${moServer.baseURL}/?file=${added.id}`);
    await expect(page.getByRole("heading", { name: "GFM Features", exact: true })).toBeVisible();
  });

  test("group route renders that group's files", async ({ moServer, page }) => {
    const added = await moServer.addFile(testdata("basic.md"), "docs");
    await page.goto(`${moServer.baseURL}/docs?file=${added.id}`);
    await expect(page.getByRole("heading", { name: "Basic Markdown" })).toBeVisible();
  });

  test("returns a non-error response on / and serves index.html", async ({
    moServer,
    page,
  }) => {
    const response = await page.goto(moServer.baseURL);
    expect(response?.status()).toBe(200);
    const html = await response?.text();
    expect((html ?? "").toLowerCase()).toContain("<!doctype html>");
  });

  test("sidebar toggle reveals/hides the sidebar", async ({ moServer, page }) => {
    await page.goto(moServer.baseURL);
    await expect(page.getByRole("heading", { name: "Initial" })).toBeVisible();

    const toggle = page.getByRole("button", { name: "Sidebar" });
    const initial = await toggle.getAttribute("aria-expanded");
    await toggle.click();
    await expect
      .poll(async () => toggle.getAttribute("aria-expanded"), { timeout: 2_000 })
      .not.toBe(initial);
  });
});
