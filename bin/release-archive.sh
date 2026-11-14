#!/bin/sh
set -eu

goos=${1:?GOOS required}
goarch=${2:?GOARCH required}
tag=${3:?tag required}
case "$goos/$goarch" in
darwin/arm64 | darwin/amd64 | linux/arm64 | linux/amd64) ;;
*)
  echo "Unsupported platform: $goos/$goarch" >&2
  exit 1
  ;;
esac
go generate ./internal/static/
commit=$(git rev-parse --short HEAD)
GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build -ldflags "-s -w -X github.com/k1LoW/mo/version.Revision=$commit" -trimpath -o mo .
mkdir -p dist
archive="dist/mo_${tag}_${goos}_${goarch}"
if [ "$goos" = darwin ]; then
  zip "${archive}.zip" mo LICENSE
else
  tar czf "${archive}.tar.gz" mo LICENSE
fi
