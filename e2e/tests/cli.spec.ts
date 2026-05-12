/**
 * E2E tests against the mo CLI.
 *
 * These tests invoke the built `mo` binary as a subprocess and verify
 * status/shutdown flows behave as users observe them. Each test runs against
 * a fresh XDG_STATE_HOME so it cannot see the developer's real mo state.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const MO_BIN = join(REPO_ROOT, "mo");

function runMo(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(MO_BIN, args, { env, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test.describe("mo CLI", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  test.beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mo-e2e-cli-"));
    env = { ...process.env, XDG_STATE_HOME: stateDir };
  });

  test.afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("--status prints the running server's address and pid", async ({ moServer }) => {
    const r = runMo(["--status", "--port", String(moServer.port)], {
      ...process.env,
      XDG_STATE_HOME: moServer.stateDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`http://localhost:${moServer.port}`);
    expect(r.stdout).toMatch(/pid \d+/);
  });

  test("--status --json emits a parseable JSON array", async ({ moServer }) => {
    const r = runMo(["--status", "--json", "--port", String(moServer.port)], {
      ...process.env,
      XDG_STATE_HOME: moServer.stateDir,
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ url: string; status: string; pid?: number }>;
    expect(Array.isArray(parsed)).toBe(true);
    const entry = parsed.find((e) => e.url === `http://localhost:${moServer.port}`);
    expect(entry?.status).toBe("running");
  });

  test("--status with no running server marks it as stopped", () => {
    const r = runMo(["--status", "--port", "6275"], env);
    expect(r.status).toBe(0);
    // Either "no mo server found" (no log dir, no servers) or "(stopped)" once
    // a log entry has been created at this port. Both indicate no live server.
    const text = r.stderr + r.stdout;
    expect(text).toMatch(/no mo server|stopped/);
  });

  test("--shutdown without a server returns an error", () => {
    const r = runMo(["--shutdown", "--port", "1", "--bind", "127.0.0.1"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no mo server");
  });

  test("--help prints usage", () => {
    const r = runMo(["--help"], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--target");
    expect(r.stdout).toContain("--watch");
  });

  test("--version prints the version string", () => {
    const r = runMo(["--version"], env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  test("missing file argument returns an error", () => {
    const r = runMo(["/no/such/path/missing-file.md", "--foreground"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("file not found");
  });

  test("--close requires a file argument", () => {
    const r = runMo(["--close"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("requires at least one file");
  });
});
