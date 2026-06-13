#!/usr/bin/env node
// driver.mjs — headless browser driver for the mo SPA.
//
// mo is a Go CLI that serves a React SPA. An agent in a headless container
// can't open a browser window, so "drive the app" means: point a headless
// Chromium at a running mo server, wait for the markdown to render, capture
// console/page errors, and write a screenshot that proves the page worked.
//
// chromium-cli is not available in this repo, but Playwright (and a Chromium
// build) ships in internal/frontend/node_modules — the same browser the e2e
// suite uses. We resolve it from there so this script needs no extra install.
//
// Usage:
//   node .claude/skills/run-mo/driver.mjs <url> [out.png] [--wait <sel>] [--settle <ms>]
//   e.g. drive a Mermaid deep link and wait for the diagram to paint:
//   node .claude/skills/run-mo/driver.mjs 'http://127.0.0.1:16275/?file=ID' \
//        /tmp/mo-shots/diagram.png --wait '.markdown-body svg[aria-roledescription]'
//
// Auth note: mo gates /_/ behind a token, but the SPA shell (any non-/_/ path)
// hands the browser a SameSite=Strict mo_token cookie on first load, so a plain
// navigation to the page "just works" — every subsequent fetch/SSE the page
// makes carries the cookie. No token wrangling needed on the browser path.
//
// Exit code is non-zero if navigation fails, .markdown-body never renders, or
// the page threw an uncaught error — so it doubles as a smoke check.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, readdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

// Resolve `playwright` from the frontend's node_modules regardless of cwd.
const requireFromFrontend = createRequire(
  pathToFileURL(resolve(repoRoot, "internal/frontend/package.json")),
);
const { chromium } = requireFromFrontend("playwright");

// This container ships a Chromium under PLAYWRIGHT_BROWSERS_PATH whose build
// number may not match what this Playwright wants (the e2e suite pins an older
// Playwright). Rather than download a second browser, find the chrome binary
// that's actually on disk and launch it directly. Returns undefined when none
// is found, so Playwright falls back to its own managed browser.
function findChrome() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const candidates = [];
  for (const dir of readdirSync(root)) {
    if (dir.startsWith("chromium-")) {
      candidates.push(resolve(root, dir, "chrome-linux/chrome"));
    } else if (dir.startsWith("chromium_headless_shell-")) {
      candidates.push(resolve(root, dir, "chrome-linux/headless_shell"));
    }
  }
  // Prefer the full chromium build over the headless shell.
  return candidates.find((p) => existsSync(p));
}

const executablePath = findChrome();

// Args: <url> [out.png] [--wait <selector>] [--settle <ms>]
// --wait   wait for an extra selector to be visible before the screenshot
//          (e.g. '.markdown-body svg' for a rendered Mermaid diagram, which
//          paints asynchronously after the markdown itself).
// --settle add a fixed pause before the screenshot (Shiki/KaTeX/Mermaid that
//          have no single stable "done" selector).
const positional = [];
let waitSelector = null;
let settleMs = 0;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--wait") waitSelector = process.argv[++i];
  else if (a === "--settle") settleMs = Number(process.argv[++i]) || 0;
  else positional.push(a);
}
const url = positional[0] ?? "http://127.0.0.1:16275/";
const out = positional[1] ?? "/tmp/mo-shots/mo.png";
mkdirSync(dirname(out), { recursive: true });

const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => pageErrors.push(String(err)));

let status = null;
try {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  status = resp?.status() ?? null;
  // The rendered markdown lives in `.markdown-body` (see FileViewer.tsx).
  await page.locator(".markdown-body").first().waitFor({ state: "visible", timeout: 15000 });
  if (waitSelector) {
    await page.locator(waitSelector).first().waitFor({ state: "visible", timeout: 15000 });
  }
  if (settleMs > 0) await page.waitForTimeout(settleMs);
} catch (err) {
  console.error(`[driver] navigation/render failed: ${err.message}`);
  await page.screenshot({ path: out, fullPage: true }).catch(() => {});
  await browser.close();
  process.exit(1);
}

const title = await page.title();
const h1 = await page.locator(".markdown-body h1").first().textContent().catch(() => null);
await page.screenshot({ path: out, fullPage: true });
await browser.close();

const result = {
  url,
  httpStatus: status,
  title,
  firstHeading: h1?.trim() ?? null,
  consoleErrors,
  pageErrors,
  screenshot: out,
};
console.log(JSON.stringify(result, null, 2));

if (pageErrors.length > 0) {
  console.error(`[driver] page threw ${pageErrors.length} uncaught error(s)`);
  process.exit(1);
}
console.error("[driver] OK");
