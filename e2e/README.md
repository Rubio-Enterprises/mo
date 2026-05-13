# E2E Tests

End-to-end tests for `mo` using [Playwright Test](https://playwright.dev/).

## Layout

```
e2e/
├── playwright.config.ts   # Playwright config (parallel, retries on CI)
├── tests/
│   ├── fixtures.ts        # Per-test mo server fixture (random port, isolated XDG_STATE_HOME)
│   ├── api.spec.ts        # HTTP API contract
│   ├── browser.spec.ts    # Browser flows (sidebar, theming, deep links)
│   └── cli.spec.ts        # CLI behaviors (--status, --shutdown, --help)
└── package.json
```

## Prerequisites

The `mo` binary must be built and present at the repo root:

```bash
make build
```

A Playwright-compatible Chromium browser must be available. In Playwright's standard install
locations (`~/.cache/ms-playwright`) or via `PLAYWRIGHT_BROWSERS_PATH`.

> **POSIX only.** The mo server fixture in `tests/fixtures.ts` spawns the binary and tears
> it down with `SIGTERM`/`SIGKILL`. Windows semantics differ (SIGTERM is forced terminate
> with no graceful shutdown), so this suite assumes macOS or Linux.

## Running

From the repo root:

```bash
cd e2e
npm install         # first time only
npm test            # run all e2e tests
npm run test:headed # run with a visible browser
npm run test:ui     # run with the Playwright UI runner
```

Tests are fully parallel — each spec gets its own mo server on a random port with a fresh
`XDG_STATE_HOME` directory, so they cannot interfere with each other or with a developer's
real session.

## Adding tests

- Prefer `test` from `./fixtures` (not the raw `@playwright/test`) so each spec gets the
  `moServer` fixture automatically.
- Use `testdata("file.md")` to refer to fixtures in `<repo>/testdata`.
- Use `moServer.addFile(absPath, group?)` to register files after the server has started.
- Tests must not assume any specific port — always use `moServer.baseURL`.
