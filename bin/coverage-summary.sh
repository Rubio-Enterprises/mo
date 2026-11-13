#!/bin/sh
set -eu
repository="${GITHUB_REPOSITORY:-$(git remote get-url origin)}"
repository="${repository#https://github.com/}"
repository="${repository#git@github.com:}"
repository="${repository%.git}"
env -i PATH="$PATH" HOME="$HOME" GITHUB_REPOSITORY="$repository" "$(mise which octocov)" dump --config .octocov-summary.yml >reports/coverage/metrics.json
node .github/scripts/coverage-summary.cjs
