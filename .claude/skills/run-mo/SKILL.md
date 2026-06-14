---
name: run-mo
description: Build, run, and drive mo — the Markdown-viewer CLI that serves a React SPA. Use when asked to build mo, start/launch the mo server, screenshot or drive its browser UI, add files via its API, or run its tests.
---

`mo` is a Go CLI that opens Markdown in a browser: it serves a React SPA and
live-reloads on save. In a headless container you can't open that browser, so
"run mo" means: build the single binary, launch the server in the background,
and drive the SPA with a headless Chromium. The driver is
`.claude/skills/run-mo/driver.mjs` (Playwright — `chromium-cli` isn't available
here); it navigates a URL, waits for the markdown to render, captures
console/page errors, and writes a screenshot. The same binary is also the CLI
(`--status`, `--json`, `--shutdown`) and exposes a token-gated HTTP API.

All paths below are relative to the repo root (the `mo` module root).

## Prerequisites

- **Go 1.26+** and **pnpm** (pnpm manages the Node version via
  `internal/frontend/package.json`). In this container they're provided by
  `mise` (`.mise.toml`) and already on `PATH` — no `apt-get` was needed.
- **A Playwright Chromium** for the driver. This container ships one at
  `$PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers`), and the driver launches it
  directly — no download, no extra system libs were required. If none is
  present, install one: `cd internal/frontend && pnpm exec playwright install chromium`.

## Build

```bash
make build
```

Runs `go generate` (which builds the frontend with pnpm — the first run
downloads the pinned Node and ~450 npm packages, ~1–2 min) then `go build`,
producing `./mo`. Verify:

```bash
./mo --version    # → mo version 0.25.5
```

## Run (agent path)

Launch the server on an **isolated** state dir (so you never clobber a real
session) and drive it. This exact block was run in this container:

```bash
export XDG_STATE_HOME=$(mktemp -d)     # isolated session
PORT=16275
./mo --port "$PORT" --bind 127.0.0.1 --no-open --foreground testdata/basic.md \
  > /tmp/mo-server.log 2>&1 &
MO_PID=$!
# The SPA shell (any non-/_/ path) needs no token, so poll "/" for readiness:
timeout 15 bash -c "until curl -sf http://127.0.0.1:$PORT/ >/dev/null; do sleep 0.2; done"

# Screenshot the rendered page:
node .claude/skills/run-mo/driver.mjs "http://127.0.0.1:$PORT/" /tmp/mo-shots/home.png
```

The driver prints a JSON result and exits non-zero on failure:

```json
{ "url": "...", "httpStatus": 200, "title": "basic.md",
  "firstHeading": "Basic Markdown", "consoleErrors": [], "pageErrors": [],
  "screenshot": "/tmp/mo-shots/home.png" }
```

| arg / flag | meaning |
|---|---|
| `<url>` | page to drive (default `http://127.0.0.1:16275/`) |
| `[out.png]` | screenshot path (default `/tmp/mo-shots/mo.png`) |
| `--wait <sel>` | also wait for this CSS selector to be visible before the shot |
| `--settle <ms>` | fixed pause before the shot (for Shiki/KaTeX with no stable marker) |

Screenshots land wherever you point `[out.png]` (default `/tmp/mo-shots/`).
Server log is `/tmp/mo-server.log`.

### Add files / deep-link via the token-gated API

The `/_/` API requires the per-server token (header `X-Mo-Token`), persisted at
`$XDG_STATE_HOME/mo/token/mo-<port>.token`. Add a file, get its ID, deep-link:

```bash
TOKEN=$(cat "$XDG_STATE_HOME/mo/token/mo-$PORT.token")
ID=$(curl -s "http://127.0.0.1:$PORT/_/api/files" \
       -H "X-Mo-Token: $TOKEN" -H "Content-Type: application/json" \
       -d "{\"path\":\"$PWD/testdata/mermaid-flowchart.md\"}" | jq -r .id)

# Mermaid paints asynchronously — wait for the real diagram svg, not just the page:
node .claude/skills/run-mo/driver.mjs "http://127.0.0.1:$PORT/?file=$ID" \
     /tmp/mo-shots/diagram.png --wait '.markdown-body svg[aria-roledescription]'
```

### Stop

```bash
kill "$MO_PID"            # or: ./mo --shutdown -p "$PORT"
```

## Run (CLI surface)

`mo` is also a CLI, and a second invocation on a port that's already serving
**adds files to the running server** instead of starting a new one:

```bash
./mo --status --json -p "$PORT"          # running servers as JSON
./mo --json -p "$PORT" testdata/gfm.md   # adds gfm.md to the live server; prints its deep-link
```

(These reuse `$XDG_STATE_HOME` to find the token, same as above.)

## Run (human path)

```bash
make dev ARGS="testdata/basic.md"   # builds, runs foreground on port 16275
# or, after `make build`:
./mo testdata/basic.md              # backgrounds itself and opens a browser
```

Useless headless (it just waits for a browser window) — use the agent path.

## Test

```bash
go test ./...        # all packages pass (~15s); the real sanity check here
```

`make e2e` builds the binary, downloads a Playwright Chromium, and runs the
Playwright suite in `e2e/` (browser, API, and CLI specs):

```bash
make e2e        # 28 specs, all pass; runs with auth on, like production
```

The fixtures are token-aware: they read the per-server `mo_token` and attach it
to the API specs' `request` calls (the browser specs go through `page`, which
gets the cookie on first navigation). No `MO_DISABLE_AUTH` needed.

## Gotchas

- **Mermaid renders async and slowly (seconds).** Waiting for `.markdown-body`
  isn't enough — you'll screenshot the *raw code* fallback. Wait for
  `.markdown-body svg[aria-roledescription]` (a real diagram). Do **not** wait
  for `.markdown-body svg`: the code-block copy buttons are `<svg>` icons inside
  `.markdown-body`, so that matches instantly and is a false positive.
- **Don't use Playwright `networkidle`.** mo holds a persistent SSE connection
  (`/_/events`) for live-reload, so the network never goes idle and `goto`
  times out. The driver uses `domcontentloaded` + an explicit element wait.
- **The `/_/` API is token-gated.** A browser *navigation* is fine — the SPA
  shell hands back a `SameSite=Strict; Secure` `mo_token` cookie, and Chromium
  sends it over plain HTTP because it treats loopback (`127.0.0.1`/`localhost`)
  as a secure context. But `curl`/`fetch` must pass
  `X-Mo-Token: $(cat $XDG_STATE_HOME/mo/token/mo-<port>.token)`. Without it you
  get `401`.
- **Playwright browser version skew.** The frontend's Playwright (1.60) wants a
  newer Chromium build than the one prebuilt at `/opt/pw-browsers` (1194,
  pinned by the e2e suite's Playwright 1.58). The driver sidesteps this by
  discovering the on-disk `chromium-*/chrome` and passing it as
  `executablePath`, so it needs no matching download.
- **External resources in the markdown are sandbox noise.** A fixture image
  like `![](https://placehold.co/...)` fails with
  `net::ERR_CERT_AUTHORITY_INVALID` / `ERR_NAME_NOT_RESOLVED`. Those surface in
  the driver's `consoleErrors` (non-fatal) — distinct from `pageErrors`
  (uncaught JS, which fails the run). Don't treat them as mo bugs.
- **Use an isolated `XDG_STATE_HOME`.** mo persists session/backups/token/logs
  there; a throwaway `mktemp -d` keeps your run from touching a real session and
  lets you delete token+state cleanly afterward.

## Troubleshooting

- **`browserType.launch: Executable doesn't exist at .../chromium_headless_shell-1223/...`**
  — Playwright/browser version skew. The driver's `findChrome()` already handles
  it by launching the on-disk build; if you bypass the driver, run
  `pnpm exec playwright install chromium` (frontend) or point `executablePath`
  at `/opt/pw-browsers/chromium-*/chrome-linux/chrome`.
- **`401 unauthorized` from `/_/api/...`** — missing token. Pass
  `X-Mo-Token` from the token file (see Gotchas).
- **`goto: Timeout ... waiting until "networkidle"`** — the SSE stream; use
  `domcontentloaded` (the driver does).
- **Screenshot shows Mermaid as a fenced code block** — you didn't wait for
  `svg[aria-roledescription]`; the diagram hadn't painted yet.
- **`make e2e`: a spec fails with `did not become ready`** — the spawned mo
  server crashed on startup (not auth — the fixtures are token-aware). Read the
  `mo-server-log` Playwright attaches to the failed test.
