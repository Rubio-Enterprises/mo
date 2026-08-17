# Agent context

This repo follows Rubio-Enterprises standards. Run `/audit-standards` from a Claude Code session to check conformance, or `/onboard-repo` for greenfield setup.

---

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `Rubio-Enterprises/mo`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain documentation layout. See `docs/agents/domain.md`.

## What is mo

`mo` is a CLI tool that opens Markdown files in a browser with live-reload. It runs a Go HTTP server that embeds a React SPA as a single binary. The Go module is `github.com/k1LoW/mo`.

## Build & Run

Requires **Go 1.26+** and [pnpm](https://pnpm.io/). The Node.js version is pinned in `.tool-versions` (managed by mise) and must satisfy the `packageManager` pin in `internal/frontend/package.json`: **pnpm 11.9.0 requires Node ≥ 22.13**, so any `go generate` / `pnpm` step fails on an older Node.

The tiers below are the complete set of ways to build, run, and test mo. Every
`make`/`pnpm` target that runs `go generate` needs Node ≥ 22.13 (see above).

### Build

- `make build` — frontend (`go generate`) + Go binary with ldflags → `./mo`
- `make generate` — frontend build only (`go generate ./internal/static/`)
- `go build -o mo .` — Go binary only (requires `internal/static/dist/` already generated)

### Run

- `make dev ARGS="testdata/basic.md"` — build, then run foreground on port 16275
- `make dev ARGS="-t design testdata/basic.md"` — with a tab group (`-t` takes one group per invocation)
- `./mo testdata/basic.md` — after `make build`; self-backgrounds and opens a browser (default port 6275)
- `cd internal/frontend && pnpm run dev` — Vite dev server, proxies `/_/` to `localhost:6275` (set `MO_DISABLE_AUTH=1` on the backend for this cross-origin flow)
- `make screenshot` — regenerate README screenshots (**requires Google Chrome**, not bundled Chromium)
- Drive a running server via the CLI — `./mo --status [--json]`, `./mo --json <file>` (adds to the running server), `--restart`, `--shutdown`, `--clear`
- Drive a running server via the API — token-gated `curl` to `/_/api/*` with `X-Mo-Token: $(cat $XDG_STATE_HOME/mo/token/mo-<port>.token)`
- Headless drive + screenshot — `node .claude/skills/run-mo/driver.mjs <url> [out.png]` (see the `run-mo` skill)

### Test — Go

- `go test ./...` — all Go packages
- `go test ./internal/server/ -run TestHandleReorderFiles` — a single Go test
- `go test ./... -coverprofile=coverage.out -covermode=count -count=1` — with coverage
- `mise run test` — gotestsum; writes JUnit to `reports/unit/junit.xml`

### Test — frontend (vitest)

- `cd internal/frontend && pnpm test` — all frontend tests
- `cd internal/frontend && pnpm test src/utils/buildTree.test.ts` — a single test file
- `cd internal/frontend && pnpm run test:coverage` — with coverage

### Test — end-to-end (Playwright, `e2e/`)

- `make e2e` — build binary, install the browser, run all specs (API + SPA + CLI)
- `cd e2e && npm test` — specs only (requires `./mo` already built)
- `cd e2e && npm run test:headed` · `test:ui` · `report` — require a display; not runnable in a headless container

### Test — combined

- `make test` — frontend coverage + Go coverage
- `make ci` — `depsdev` + `generate` + `test` (matches the CI `Test` job)

### Lint / format / hooks

- `make lint` — oxlint (frontend) + golangci-lint + gostyle (run `make depsdev` once to install gostyle/gocredits)
- `mise run lint` — golangci-lint only
- `make fmt` / `make fmt-check` — oxfmt write / check
- `cd internal/frontend && pnpm run lint` · `pnpm run fmt` · `pnpm run fmt:check` — frontend directly
- `mise exec -- lefthook run pre-commit --all-files` — run all git hooks across the repo

### CLI Flags

- `--port` / `-p` — Server port (default: 6275)
- `--target` / `-t` — Tab group name (default: `"default"`)
- `--bind` / `-b` — Bind address (default: `localhost`). Non-loopback addresses expose mo to the network **without authentication** (confirmation prompt shown).
- `--open` — Always open browser
- `--no-open` — Never open browser
- `--watch` / `-w` — Glob pattern to watch for matching files (repeatable)
- `--unwatch` — Remove a watched glob pattern (repeatable)
- `--close` — Close files instead of opening them
- `--status` — Show status of all running mo servers
- `--shutdown` — Shut down the running mo server
- `--restart` — Restart the running mo server
- `--clear` — Clear saved session (restarts server if running)
- `--foreground` — Run mo server in foreground (do not background)
- `--json` — Output structured data as JSON to stdout
- `--dangerously-allow-remote-access` — Allow remote access without authentication (trusted networks only)

## Architecture

**Go backend + embedded React SPA**, single binary.

- `cmd/root.go` — CLI entry point (Cobra). Handles single-instance detection: if a server is already running on the port, adds files via HTTP API instead of starting a new server.
- `internal/server/server.go` — HTTP server, state management (mutex-guarded), SSE for live-reload, file watcher (fsnotify). All API routes use `/_/` prefix to avoid collision with SPA route paths (group names).
- `internal/static/static.go` — `go:generate` runs the frontend build, then `go:embed` embeds the output from `internal/static/dist/`.
- `internal/frontend/` — Vite + React 19 + TypeScript + Tailwind CSS v4 SPA. Build output goes to `internal/static/dist/` (configured in `vite.config.ts`).
- `internal/backup/` — State persistence for open files/groups using atomic JSON writes to `$XDG_STATE_HOME/mo/backup/`. Enables session restoration across server restarts.
- `internal/logfile/` — Rotating JSON logging to `$XDG_STATE_HOME/mo/log/` (max 10MB, 3 backups, 7-day retention).
- `internal/xdg/` — XDG Base Directory helper. `StateHome()` returns `$XDG_STATE_HOME` or default `~/.local/state`.
- `version/version.go` — the fork's version string (`Version`), bumped by the release commit; the release workflow refuses to publish a tag that disagrees with it. `Revision` is injected via ldflags at build time. Upstream's tagpr does **not** run in this fork.

## Frontend

- Package manager: **pnpm** (version specified in `internal/frontend/package.json` `packageManager` field)
- Markdown rendering: `react-markdown` + `remark-gfm` + `rehype-raw` + `rehype-slug` (heading IDs) + `@shikijs/rehype` (syntax highlighting) + `mermaid` (diagram rendering)
- SPA routing via `window.location.pathname` (no router library)
- Key components: `App.tsx` (routing/state), `Sidebar.tsx` (file list with flat/tree view, resizable, drag-and-drop reorder), `TreeView.tsx` (tree view with collapsible directories), `MarkdownViewer.tsx` (rendering + raw view toggle), `TocPanel.tsx` (table of contents, resizable), `GroupDropdown.tsx` (group switcher), `FileContextMenu.tsx` (shared kebab menu for file operations), `WidthToggle.tsx` (wide/narrow content width toggle)
- Custom hooks: `useSSE.ts` (SSE subscription with auto-reconnect), `useApi.ts` (typed API fetch wrappers), `useActiveHeading.ts` (scroll-based active heading tracking via IntersectionObserver)
- Utilities: `buildTree.ts` (converts flat file list to hierarchical tree with common prefix removal and single-child directory collapsing)
- Theme: GitHub-style light/dark via CSS custom properties (`--color-gh-*`) in `styles/app.css`, toggled by `data-theme` attribute on `<html>`. UI components use Tailwind classes like `bg-gh-bg-sidebar`, `text-gh-text-secondary`, etc.
- Toggle button pattern: `RawToggle.tsx` and `TocToggle.tsx` follow the same style (`bg-transparent border border-gh-border rounded-md p-1.5 text-gh-text-secondary`). Header buttons (`ViewModeToggle`, `ThemeToggle`, `WidthToggle`, sidebar toggle) use `text-gh-header-text` instead. New buttons should match the appropriate variant.

## Key Design Patterns

- **Single instance**: CLI probes `/_/api/status` on the target port via `probeServer()`. If already running, pushes files via `POST /_/api/files` and exits.
- **File IDs**: Files get deterministic string IDs derived from the SHA-256 hash of the absolute path (first 8 hex characters). IDs are stable across server restarts, enabling deep linking. The frontend primarily references files by ID. Absolute paths are available via `FileEntry.path` for display (e.g., tooltip, tree view).
- **Tab groups**: Files are organized into named groups. Group name maps to the URL path (e.g., `/design`). Default group name is `"default"`.
- **Live-reload via SSE**: fsnotify watches files; `file-changed` events trigger frontend to re-fetch content by file ID.
- **Sidebar view modes**: Flat (default, with drag-and-drop reorder via dnd-kit) and tree (hierarchical directory view). View mode is persisted per-group in localStorage. Collapsed directory state is managed inside `TreeView` and also persisted per-group.
- **Resizable panels**: Both `Sidebar.tsx` (left) and `TocPanel.tsx` (right) use the same drag-to-resize pattern with localStorage persistence. Left sidebar uses `e.clientX`, right panel uses `window.innerWidth - e.clientX`.
- **Toolbar buttons in content area**: The toolbar column (ToC + Raw toggles) lives inside `MarkdownViewer.tsx`, positioned with `shrink-0 flex flex-col gap-2 -mr-4 -mt-4` to align with the header.
- **State persistence**: Server state (files, groups, patterns) is backed up to `$XDG_STATE_HOME/mo/backup/mo-<port>.json` via `internal/backup`. On `--restart`, the server reloads this state to preserve the session. When starting a new server, backup is always restored and merged with CLI-specified files/patterns (restored entries first, CLI entries appended, duplicates skipped). The backup file is preserved across clean `--shutdown` and is only removed via the `--clear` path in the CLI.
- **Glob pattern watching**: `--watch` registers glob patterns that are expanded to matching files and monitored for new files via fsnotify directory watches. Patterns are stored with reference-counted directory watches (`watchedDirs map[string]int`). `--unwatch` removes patterns and decrements watch ref counts. Groups persist as long as they have files or patterns.
- **localStorage conventions**: All keys use `mo-` prefix (e.g., `mo-sidebar-width`, `mo-sidebar-viewmode`, `mo-sidebar-tree-collapsed`, `mo-theme`). Read patterns use `try/catch` around `JSON.parse` with fallback defaults.
- **API authentication**: On startup the server mints a random per-server token (`internal/token`), persists it `0600` to `$XDG_STATE_HOME/mo/token/mo-<port>.token`, and calls `state.SetAuth()`. The `withAuth` middleware (in `NewHandler`) requires the token on all `/_/` requests via the `X-Mo-Token` header (used by the CLI, which injects it through a `tokenRoundTripper` on its `http.Client`) or the `mo_token` cookie (a `SameSite=Strict; HttpOnly` cookie issued to the same-origin SPA on any non-`/_/` response). This blocks cross-site/CSRF abuse of the localhost API (a malicious page can't read the token file or send the SameSite cookie) **without** restricting which local files can be opened — that arbitrary-path capability is core to mo. `withAuth` also enforces a loopback `Host` allowlist (DNS-rebinding defense) for non-remote binds. The token file is removed on `--clear`. Auth is disabled when no token is set (tests use `NewHandler` without `SetAuth`); `MO_DISABLE_AUTH=1` disables it at runtime for the cross-origin `pnpm run dev` proxy workflow (never set it otherwise).

## API Conventions

All internal endpoints use `/_/api/` prefix and SSE uses `/_/events`. The `/_/` prefix avoids collisions with user-facing group name routes. All `/_/` requests require authentication (see **API authentication** under Key Design Patterns).

Key endpoints:

- `GET /_/api/groups` — List all groups with files
- `POST /_/api/files` — Add file
- `DELETE /_/api/files/{id}` — Remove file
- `GET /_/api/files/{id}/content` — File content (markdown)
- `PUT /_/api/files/{id}/group` — Move file to another group
- `PUT /_/api/reorder` — Reorder files in a group (group name in body)
- `POST /_/api/files/open` — Open relative file link
- `POST /_/api/patterns` — Add glob watch pattern
- `DELETE /_/api/patterns` — Remove glob watch pattern
- `GET /_/api/status` — Server status (version, pid, groups with patterns)
- `GET /_/events` — SSE (event types: `update`, `file-changed`, `restart`)

## Linting

Go linters (`.golangci.yml`): errorlint, godot, gosec, misspell (US locale), revive, funcorder, modernize. Type assertions must be checked (`check-type-assertions: true`). Comments preset exclusions are applied.

gostyle (`.gostyle.yml`): mixedcaps and funcfmt analyzers are disabled. errorstrings analysis excludes tests.

Frontend: ESLint via `pnpm run lint` in `internal/frontend/`. Formatting via `pnpm run fmt` (check with `pnpm run fmt:check`).

## CI/CD

- **CI**: golangci-lint (via reviewdog), gostyle, `make ci` (test + coverage), octocov
- **Release**: tags matching `v*-strubio.*` trigger `.github/workflows/tagpr.yml`. The `go generate` step (frontend build) runs before cross-platform Go builds; binaries are uploaded as a GitHub release and `Formula/mo.rb` in `Rubio-Enterprises/homebrew-tap` is rewritten in the same job. There is no tagpr and no goreleaser in this fork.
- **License check**: `.github/workflows/license-scan.yml` runs Trivy's license scanner on PRs and pushes to `main`. It replaces the manually disabled upstream `trivy.yml` path so GitHub registers the preserved check as an active workflow.
- CI requires pnpm setup (`pnpm/action-setup`) before any Go build step because `go generate` triggers the frontend build.

### Release Tags

This fork tags releases **`v<X.Y.Z>-strubio.<N>`** (e.g. `v1.6.7-strubio.1`), where:

- `X.Y.Z` mirrors the **upstream `k1LoW/mo` version this fork carries** — read it off the top of `CHANGELOG.md`.
- `N` counts fork rebuilds against that same upstream version, starting at `1`.

So `v1.6.7-strubio.2` means "the second fork build of upstream 1.6.7". `mo --version` prints the whole string, which is the point: the old scheme's `0.27.0` was a fork-private counter that told you nothing about which upstream mo you were running.

The tag is a valid semver prerelease, so it needs no prefix-strip configuration anywhere; the Homebrew formula version is just the tag minus its leading `v`. This matches `Formula/marvin-cli.rb` in the same tap.

To release:

1. Set `Version` in `version/version.go` to the tag without its leading `v` (e.g. `1.6.7-strubio.1`)
2. Commit and push
3. Tag and push: `git tag v<X.Y.Z>-strubio.<N> && git push origin v<X.Y.Z>-strubio.<N>`

The workflow's `verify` job fails the release if step 1 was skipped, before any build runs or the tap is touched.

Two constraints worth not rediscovering the hard way:

- **The trigger glob must stay `v*-strubio.*`.** Origin already carries 44 upstream tags (`v0.1.0` … `v0.20.1`), and the local clone holds more up to `v1.6.7`; a bare `v*` glob would fire a full matrix build and a garbage tap write for every one of them.
- **`.github/workflows/tagpr.yml` keeps its misleading filename on purpose.** Upstream owns that path, so holding it stops upstream's tagpr + goreleaser pipeline from reappearing through a sync merge. Renaming it to `release.yml` would let upstream's version land as a plain file addition and run on every push to `main`.

Tags from the retired `strubio-v*` scheme (`strubio-v0.1.0` … `strubio-v0.27.0`) stay on origin as tombstones — no history rewrite. Homebrew upgrades cleanly across the cutover because `1.6.7-strubio.1` outranks `0.27.0` on the first version token.
