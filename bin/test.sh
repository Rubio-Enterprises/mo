#!/bin/sh
set -eu
mkdir -p reports/test reports/coverage
(
  set --
  set -eu
  gotestsum --junitfile reports/test/go.xml -- -covermode=count -coverprofile=reports/coverage/go.out -count=1 ./... "$@"
)
bin/test-ts.sh
node --test --test-reporter=spec --test-reporter=junit --test-reporter-destination=stdout --test-reporter-destination=reports/test/coverage-reporter.xml .github/scripts/coverage-report.test.cjs
