#!/bin/sh
set -eu
pnpm --dir internal/frontend exec vitest run --reporter=default --reporter=junit --outputFile.junit="${REPO_DIR:-$(pwd)}"/reports/test/frontend.xml "$@"
