#!/bin/sh
set -eu
mkdir -p reports/test reports/coverage
gotestsum --junitfile reports/test/go.xml -- -covermode=count -coverprofile=reports/coverage/go.out -count=1 ./... "$@"
