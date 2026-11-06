#!/bin/sh
set -eu
pnpm --dir internal/frontend exec tsc --noEmit "$@"
