<p align="center">
<br><br><br>
<img src="https://github.com/k1LoW/mo/raw/main/images/logo.svg" width="120" alt="mo">
<br><br><br>
</p>

# mo

<!-- badges: start -->
[![build](https://github.com/k1LoW/mo/actions/workflows/ci.yml/badge.svg)](https://github.com/k1LoW/mo/actions/workflows/ci.yml) ![Coverage](https://raw.githubusercontent.com/k1LoW/octocovs/main/badges/k1LoW/mo/coverage.svg) ![Code to Test Ratio](https://raw.githubusercontent.com/k1LoW/octocovs/main/badges/k1LoW/mo/ratio.svg) ![Test Execution Time](https://raw.githubusercontent.com/k1LoW/octocovs/main/badges/k1LoW/mo/time.svg)
<!-- badges: end -->

> `mo` is a **M**arkdown viewer that **o**pens `.md` files in a browser.

## What it is

`mo` is an experimental Go CLI that opens Markdown files in your browser with live-reload. It runs a small HTTP server (default port `6275`) that embeds a React SPA as a single binary, so saving a watched file refreshes the browser automatically. Use it for previewing docs, drafting specs, or wiring rendered Markdown into scripts and LLM-driven workflows.

Highlights:

- GitHub-flavored Markdown (tables, task lists, footnotes, etc.)
- Syntax highlighting ([Shiki](https://shiki.style/))
- [Mermaid](https://mermaid.js.org/) diagram rendering
- LaTeX math rendering ([KaTeX](https://katex.org/))
- <img src="images/icons/theme-light.svg" width="16" height="16" alt="dark theme"> Dark / <img src="images/icons/theme-dark.svg" width="16" height="16" alt="light theme"> light theme
- <img src="images/icons/group.svg" width="16" height="16" alt="group"> File grouping
- <img src="images/icons/toc.svg" width="16" height="16" alt="toc"> Table of contents panel
- <img src="images/icons/view-flat.svg" width="16" height="16" alt="flat view"> Flat / <img src="images/icons/view-tree.svg" width="16" height="16" alt="tree view"> tree sidebar view with drag-and-drop reorder and file search
- <img src="images/icons/title-filename.svg" width="16" height="16" alt="file name"> File name / <img src="images/icons/title-heading.svg" width="16" height="16" alt="heading title"> heading title sidebar display toggle (per-group)
- YAML frontmatter display (collapsible metadata block)
- MDX file support (renders as Markdown, strips `import`/`export`, escapes JSX tags)
- <img src="images/icons/width-expand.svg" width="16" height="16" alt="wide view"> Wide / <img src="images/icons/width-compress.svg" width="16" height="16" alt="narrow view"> narrow content width toggle
- <img src="images/icons/raw.svg" width="16" height="16" alt="raw"> Raw markdown view
- <img src="images/icons/copy.svg" width="16" height="16" alt="copy"> Copy content (Markdown / Text / HTML)
- <img src="images/icons/restart.svg" width="16" height="16" alt="restart"> Server restart with session preservation
- Auto session backup and restore
- Drag-and-drop file addition from the OS file manager (content is loaded in-memory; live-reload is not supported for dropped files)
- Live-reload on save (for files opened via CLI)

## Install

**homebrew tap:**

```console
brew install k1LoW/tap/mo
```

**go install:**

```console
go install github.com/k1LoW/mo@latest
```

**manually:**

Download a binary from the [releases page](https://github.com/k1LoW/mo/releases).

## Usage

```console
mo README.md                          # Open a single file
mo README.md CHANGELOG.md docs/*.md   # Open multiple files
mo spec.md --target design            # Open in a named group
```

`mo` opens Markdown files in a browser with live-reload. When you save a file, the browser automatically reflects the changes.

### Single server, multiple files

By default, `mo` runs a single server on port `6275`. If a server is already running on the same port, subsequent `mo` invocations add files to the existing session instead of starting a new one.

```console
mo README.md          # Starts a mo server in the background
mo CHANGELOG.md       # Adds the file to the running mo server
```

To run a completely separate session, use a different port:

```console
mo draft.md -p 6276
```

![Multiple files with sidebar](images/multiple-files.png)

### Groups

Files can be organized into named groups using the `--target` (`-t`) flag. Each group gets its own URL path and sidebar.

```console
mo spec.md --target design      # Opens at http://localhost:6275/design
mo api.md --target design       # Adds to the "design" group
mo notes.md --target notes      # Opens at http://localhost:6275/notes
```

![Group view](images/groups.png)

### Glob pattern watching

Use `--watch` (`-w`) to specify glob patterns. Matching files are opened automatically, and watched directories are monitored for new files.

```console
mo --watch '**/*.md'                          # Watch and open all .md files recursively
mo --watch 'docs/**/*.md' --target docs       # Watch docs/ tree in "docs" group
mo --watch '*.md' --watch 'docs/**/*.md'      # Multiple patterns
```

`--watch` cannot be combined with file arguments. The `**` pattern matches directories recursively.

#### Removing watch patterns

Use `--unwatch` to stop watching a previously registered pattern. Files already added remain in the sidebar.

```console
mo --unwatch '**/*.md'                              # Stop watching a pattern (default group)
mo --unwatch 'docs/**/*.md' --target docs            # Stop watching in a specific group
mo --unwatch '/Users/you/project/**/*.md'            # Stop watching by absolute path
```

Patterns are resolved to absolute paths before matching, so you can specify either a relative glob or the full path shown by `--status`.

### Sidebar view modes

The sidebar supports flat and tree view modes. Flat view shows file names only, while tree view displays the directory hierarchy.

| <img src="images/icons/view-flat.svg" alt="flat view icon" height="16"> Flat | <img src="images/icons/view-tree.svg" alt="tree view icon" height="16"> Tree |
|------|------|
| ![Flat view](images/sidebar-flat.png) | ![Tree view](images/sidebar-tree.png) |

### Starting and stopping

`mo` runs in the background by default — the command returns immediately, leaving the shell free for other work. This makes it easy to incorporate into scripts, tool chains, or LLM-driven workflows.

```console
$ mo README.md
mo: serving at http://localhost:6275 (pid 12345)
$ # shell is available immediately
```

Use `--status` to check all running mo servers, and `--shutdown` to stop one:

```console
$ mo --status              # Show all running mo servers
http://localhost:6275 (pid 12345, v0.12.0)
  default: 5 file(s)
    watching: /Users/you/project/src/**/*.md, /Users/you/project/*.md
  docs: 2 file(s)
    watching: /Users/you/project/docs/**/*.md

$ mo --shutdown            # Shut down the mo server on the default port
$ mo --shutdown -p 6276    # Shut down the mo server on a specific port
$ mo --restart             # Restart the mo server on the default port
```

If you need the mo server to run in the foreground (e.g. for debugging), use `--foreground`:

```console
mo --foreground README.md
```

### Server restart

Click the <img src="images/icons/restart.svg" width="16" height="16" alt="restart"> restart button (bottom-right corner) or run `mo --restart` to restart the `mo` server process. The current session — all open files and groups — is preserved across the restart. This is useful when you have updated the `mo` binary and want to pick up the new version without re-opening your files.

### Session backup and restore

`mo` automatically saves session state (open files and watch patterns per group) when files are added or removed. When starting a new server, the previous session is automatically restored and merged with any files specified on the command line. Restored session entries appear first, followed by newly specified files.

```console
mo README.md CHANGELOG.md       # Start with two files
mo --shutdown                   # Shut down the server
mo                              # Restores README.md and CHANGELOG.md
mo TODO.md                      # Restores previous session + adds TODO.md
```

Use `--close` to remove specific files from the running server:

```console
mo --close README.md            # Close a file from the default group
mo --close docs/*.md -t docs    # Close files from the "docs" group
```

Use `--clear` to remove a saved session. If a server is running, it is automatically restarted with an empty state:

```console
mo --clear                      # Clear saved session for the default port
mo --clear -p 6276              # Clear saved session for a specific port
```

### JSON output

Use `--json` to get structured JSON output on stdout, useful for scripting and integration with other tools.

```console
$ mo --json README.md
{
  "url": "http://localhost:6275",
  "files": [
    {
      "url": "http://localhost:6275/?file=a1b2c3d4",
      "name": "README.md",
      "path": "/Users/you/project/README.md"
    }
  ]
}
```

`--status` also supports `--json`:

```console
$ mo --status --json
[
  {
    "url": "http://localhost:6275",
    "status": "running",
    "pid": 12345,
    "version": "0.15.0",
    "revision": "abc1234",
    "groups": [
      {
        "name": "default",
        "files": 3,
        "patterns": ["**/*.md"]
      }
    ]
  }
]
```

## Configuration

`mo` is configured entirely via CLI flags — there is no config file. Flags apply per invocation; persistent state (open files, watch patterns per group) is auto-saved to the on-disk session and restored on the next start.

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--target` | `-t` | `default` | Group name |
| `--port` | `-p` | `6275` | Server port |
| `--bind` | `-b` | `localhost` | Bind address (e.g. `0.0.0.0`) |
| `--open` | | | Always open browser |
| `--no-open` | | | Never open browser |
| `--status` | | | Show all running mo servers |
| `--watch` | `-w` | | Glob pattern to watch for matching files (repeatable) |
| `--unwatch` | | | Remove a watched glob pattern (repeatable) |
| `--close` | | | Close files instead of opening them |
| `--shutdown` | | | Shut down the running mo server |
| `--restart` | | | Restart the running mo server |
| `--clear` | | | Clear saved session (restarts server if running) |
| `--foreground` | | | Run mo server in foreground |
| `--json` | | | Output structured data as JSON to stdout |
| `--trusted-host` | | | Extra `Host` header value to accept behind a trusted reverse proxy, repeatable (e.g. `host.example.ts.net:8443`) |

> [!WARNING]
> Binding to a non-localhost address exposes mo to the network **without any authentication**. Remote clients can read any file accessible by the user, browse the filesystem via glob patterns, and shut down the server. A confirmation prompt is shown when `--bind` is set to a non-loopback address.

<!-- -->

> [!NOTE]
> **Behind a reverse proxy (e.g. Tailscale Serve):** keep the default `--bind localhost` and let the proxy terminate TLS. A proxy forwards its own `Host` header, which mo's DNS-rebinding allowlist rejects by default (`403 forbidden`). Add that hostname with `--trusted-host host.example.ts.net:8443` (repeatable, and include the port unless it is the scheme default). Loopback binding, the token cookie, and rebinding defense for every other `Host` all stay in force. mo's auth cookie is `Secure`, so the proxy must serve HTTPS — Tailscale Serve does. A root-mounted SPA like mo needs its **own** listener at `/`, not a sub-path, so its absolute asset URLs resolve.

## Development

Requires Go 1.26+ and [pnpm](https://pnpm.io/). Node.js is pinned via `pnpm.executionEnv.nodeVersion` in `internal/frontend/package.json`; other runtimes are pinned via `.tool-versions` / `.mise.toml`.

```bash
git clone https://github.com/Rubio-Enterprises/mo.git
cd mo
mise install                       # install pinned runtimes from .tool-versions
lefthook install                   # register git hooks

# Full build (frontend + Go binary, with ldflags)
make build

# Dev: build frontend then run with args (uses port 16275, foreground mode)
make dev ARGS="testdata/basic.md"

# Lint
golangci-lint run

# Tests with JUnit output (Rubio-Enterprises go-cli standard)
gotestsum --junitfile=reports/unit/junit.xml -- ./...

# Or via make
make test
make lint
```

For deeper agent / contributor notes (single-test invocations, frontend dev server, screenshots), see [`AGENTS.md`](AGENTS.md).

## License

- [MIT License](LICENSE)
  - Include logo as well as source code.
  - Only logo license can be selected [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  - Also, if there is no alteration to the logo and it is used for technical information about mo, I would not say anything if the copyright notice is omitted.

### References

- [yusukebe/gh-markdown-preview](https://github.com/yusukebe/gh-markdown-preview): GitHub CLI extension to preview Markdown looks like GitHub.
