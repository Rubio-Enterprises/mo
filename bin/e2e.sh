#!/bin/sh
set -eu
if [ -n "${CI:-}" ] && sudo -n true 2>/dev/null; then (cd e2e && npx --no-install playwright install-deps chromium); fi
make e2e
