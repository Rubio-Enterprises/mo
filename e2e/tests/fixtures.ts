import { test as base } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const MO_BIN = join(REPO_ROOT, "mo");
const TESTDATA = join(REPO_ROOT, "testdata");

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

async function waitForServer(baseURL: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/_/api/status`);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`mo server at ${baseURL} did not become ready within ${timeoutMs}ms`);
}

export interface MoServerHandle {
  baseURL: string;
  port: number;
  stateDir: string;
  addFile(absPath: string, group?: string): Promise<{ id: string; name: string; path: string }>;
}

interface Fixtures {
  moServer: MoServerHandle;
}

/**
 * Per-test mo server. Each test gets:
 *   - A unique port
 *   - A fresh XDG_STATE_HOME so backups/logs don't collide
 *   - A running mo process (foreground mode) that is torn down after the test
 *
 * The `addFile` helper uses the mo HTTP API to register files for the test.
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

    const handle: MoServerHandle = {
      baseURL,
      port,
      stateDir,
      async addFile(absPath: string, group = "default") {
        const res = await fetch(`${baseURL}/_/api/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
      await fetch(`${baseURL}/_/api/shutdown`, { method: "POST" });
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
});

export { expect } from "@playwright/test";
export const testdata = (file: string) => join(TESTDATA, file);
