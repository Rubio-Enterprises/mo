#!/bin/sh
set -eu
pnpm --dir internal/frontend install --frozen-lockfile
npm ci --prefix e2e --no-audit --no-fund
