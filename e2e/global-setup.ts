/**
 * Playwright global setup.
 *
 * Runs once before the test suite. Currently it fails fast with a clear
 * message if the `mo` binary hasn't been built yet — this avoids confusing
 * Playwright errors from the per-test fixture that spawns the binary.
 */

import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const MO_BIN = join(REPO_ROOT, "mo");

export default function globalSetup(): void {
  if (!existsSync(MO_BIN)) {
    throw new Error(
      `mo binary not found at ${MO_BIN}. Run 'make build' from the repo root first.`,
    );
  }
}
