#!/bin/sh
set -eu
(
  set --
  set -eu
  gotestsum --junitfile reports/test/go.xml -- -count=1 ./... "$@"
)
bin/test-ts.sh
