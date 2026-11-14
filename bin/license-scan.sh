#!/bin/sh
set -eu

go mod download
pnpm --dir internal/frontend install --frozen-lockfile
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
mkdir -p "$scratch/pkg"
ln -s "$(go env GOMODCACHE)" "$scratch/pkg/mod"
export GOPATH="$scratch"
trivy fs --scanners license --format json --output "$scratch/licenses.json" .
python - "$scratch/licenses.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as report:
    results = json.load(report).get("Results", [])
for target in ("go.mod", "internal/frontend/pnpm-lock.yaml"):
    count = sum(len(item.get("Licenses", [])) for item in results if item.get("Target") == target)
    print(f"{target}: {count} license findings")
    if not count:
        raise SystemExit(f"No license findings for {target}")
PY
trivy fs --scanners license --format table --exit-code 1 --severity UNKNOWN,MEDIUM,HIGH .
