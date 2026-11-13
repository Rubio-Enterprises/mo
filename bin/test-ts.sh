#!/bin/sh
set -eu
pnpm --dir internal/frontend exec vitest run --coverage --coverage.reportsDirectory="${REPO_DIR:-$(pwd)}"/reports/coverage/frontend --reporter=default --reporter=junit --outputFile.junit="${REPO_DIR:-$(pwd)}"/reports/test/frontend.xml "$@"
