import { test as base } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const MO_BIN = join(REPO_ROOT, "mo");
const TESTDATA = join(REPO_ROOT, "testdata");

// mo gates every /_/ request behind a per-server token (header or cookie).
const AUTH_HEADER = "X-Mo-Token";

async function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        rej(new Error("could not determine free port"));
      }
    });
  });
}

// Probe the SPA shell ("/") for readiness. Auth gates every /_/ route — including
// /_/api/status — but the shell is served unauthenticated (and hands the browser
// the mo_token cookie), so it's the right token-free readiness signal.
async function waitForServer(baseURL: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/`);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`mo server at ${baseURL} did not become ready within ${timeoutMs}ms`);
}

// The server mints its auth token and writes it to
// $XDG_STATE_HOME/mo/token/mo-<port>.token BEFORE it binds the listener, so by
// the time waitForServer() sees "/" the file exists. Returns "" when auth is
// disabled (MO_DISABLE_AUTH=1) — then no token file is written and none is needed.
function readToken(stateDir: string, port: number): string {
  try {
    return readFileSync(join(stateDir, "mo", "token", `mo-${port}.token`), "utf-8").trim();
  } catch {
    return "";
  }
}

export interface MoServerHandle {
  baseURL: string;
  port: number;
  stateDir: string;
  /** Per-server auth token; "" when MO_DISABLE_AUTH=1. Required on /_/ requests. */
  token: string;
  addFile(absPath: string, group?: string): Promise<{ id: string; name: string; path: string }>;
}

interface Fixtures {
  moServer: MoServerHandle;
}

/**
 * Per-test mo server. Each test gets:
 *   - A unique port
 *   - A fresh XDG_STATE_HOME so backups/logs/token don't collide
 *   - A running mo process (foreground mode) that is torn down after the test
 *
 * The server runs with auth ON (as in production). The fixture reads the
 * per-server token and attaches it to every /_/ call it makes (addFile,
 * shutdown) and — via the overridden `request` fixture below — to the API specs'
 * direct requests. Browser specs go through `page`, which gets the mo_token
 * cookie on first navigation, so they need no token wrangling.
 */
export const test = base.extend<Fixtures>({
  moServer: async ({}, use, testInfo) => {
    const port = await findFreePort();
    const stateDir = mkdtempSync(join(tmpdir(), `mo-e2e-${testInfo.workerIndex}-`));
    const baseURL = `http://127.0.0.1:${port}`;

    // Provide one initial file so the server doesn't exit immediately.
    const initialMd = join(stateDir, "initial.md");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(initialMd, "# Initial\n\nThis file is added at startup.\n");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_STATE_HOME: stateDir,
    };

    const proc: ChildProcess = spawn(
      MO_BIN,
      [
        "--port",
        String(port),
        "--bind",
        "127.0.0.1",
        "--no-open",
        "--foreground",
        initialMd,
      ],
      { env, stdio: "pipe" },
    );

    // Collect output for diagnostics on failure.
    let serverLog = "";
    proc.stdout?.on("data", (d) => {
      serverLog += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      serverLog += d.toString();
    });

    proc.on("exit", (code, signal) => {
      if (code != null && code !== 0 && code !== null) {
        // Surface unexpected exits in the next assertion failure.
        serverLog += `\n[server exited code=${code} signal=${signal}]\n`;
      }
    });

    try {
      await waitForServer(baseURL);
    } catch (err) {
      proc.kill("SIGKILL");
      throw new Error(`${(err as Error).message}\n--- server output ---\n${serverLog}`);
    }

    // The token is persisted before the server starts listening, so it is
    // readable now. Attach it to every /_/ request the fixture makes.
    const token = readToken(stateDir, port);
    const authHeaders: Record<string, string> = token ? { [AUTH_HEADER]: token } : {};

    const handle: MoServerHandle = {
      baseURL,
      port,
      stateDir,
      token,
      async addFile(absPath: string, group = "default") {
        const res = await fetch(`${baseURL}/_/api/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ path: absPath, group }),
        });
        if (!res.ok) {
          throw new Error(`addFile failed: ${res.status} ${await res.text()}`);
        }
        return res.json();
      },
    };

    await use(handle);

    // Teardown: shut down the server, then clean up state dir.
    try {
      await fetch(`${baseURL}/_/api/shutdown`, { method: "POST", headers: authHeaders });
    } catch {
      // ignore
    }
    proc.kill("SIGTERM");
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        r();
      }, 1000);
      proc.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
    rmSync(stateDir, { recursive: true, force: true });

    // Attach log on failure so flakes are diagnosable.
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("mo-server-log", { body: serverLog, contentType: "text/plain" });
    }
  },

  // Override the built-in `request` fixture with one that carries the auth token.
  // The API specs hit /_/ directly through `request` (no browser, so no cookie),
  // so without this they'd all 401. Browser specs use `page` / `page.request`,
  // which carry the mo_token cookie set on first navigation, and are unaffected.
  request: async ({ playwright, moServer }, use) => {
    const ctx = await playwright.request.newContext({
      extraHTTPHeaders: moServer.token ? { [AUTH_HEADER]: moServer.token } : {},
    });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect } from "@playwright/test";
export const testdata = (file: string) => join(TESTDATA, file);
