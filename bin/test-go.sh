#!/bin/sh
set -eu
gotestsum --junitfile reports/test/go.xml -- -count=1 ./... "$@"
