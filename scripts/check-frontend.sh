#!/usr/bin/env bash
# Run the existing frontend tools, restricting CI to files introduced by the
# PR/merge group. An unset base means the usual full-tree local check.
set -euo pipefail

mode=${1:?expected lint or format}
case "$mode" in
  lint|format) ;;
  *) echo "Unknown frontend check: $mode" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
if [[ -z ${RUBIO_CHANGED_BASE:-} ]]; then
  if [[ $mode == lint ]]; then
    pnpm --dir internal/frontend run lint
  else
    pnpm --dir internal/frontend run fmt:check
  fi
  exit
fi

# Do not turn a missing/invalid comparison base into a passing empty check.
git cat-file -e "${RUBIO_CHANGED_BASE}^{commit}"
files=()
full_tree=false
while IFS= read -r -d '' file; do
  case "$file" in
    internal/frontend/package.json|internal/frontend/pnpm-lock.yaml|internal/frontend/.oxlintrc.json|internal/frontend/.oxfmtrc.json|scripts/check-frontend.sh|.mise.local.toml)
      full_tree=true ;;
    internal/frontend/src/*)
      [[ -f $file ]] || continue
      case "$file" in
        *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts|*.cts)
          files+=("${file#internal/frontend/}") ;;
        *.css|*.scss|*.json|*.md|*.mdx|*.html|*.yaml|*.yml)
          if [[ $mode == format ]]; then files+=("${file#internal/frontend/}"); fi ;;
      esac ;;
  esac
done < <(git diff --name-only --diff-filter=ACMRD -z "$RUBIO_CHANGED_BASE" HEAD -- internal/frontend/src internal/frontend/package.json internal/frontend/pnpm-lock.yaml internal/frontend/.oxlintrc.json internal/frontend/.oxfmtrc.json scripts/check-frontend.sh .mise.local.toml)

if [[ $full_tree == true ]]; then
  echo "Frontend $mode: check configuration changed; checking all src/"
  if [[ $mode == lint ]]; then
    pnpm --dir internal/frontend run lint
  else
    pnpm --dir internal/frontend run fmt:check
  fi
elif (( ${#files[@]} )); then
  echo "Frontend $mode: checking ${#files[@]} changed applicable file(s):"
  printf '  %s\n' "${files[@]}"
  cd internal/frontend
  if [[ $mode == lint ]]; then
    pnpm exec oxlint -c .oxlintrc.json --disable-nested-config "${files[@]}"
  else
    pnpm exec oxfmt -c .oxfmtrc.json --check "${files[@]}"
  fi
else
  echo "Frontend $mode: no changed applicable files; git diff ${RUBIO_CHANGED_BASE}..HEAD contains no matching src/ files or tool configuration."
fi
