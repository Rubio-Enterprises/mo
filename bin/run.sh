#!/bin/sh
set -eu
make build
./mo -p 16275 --foreground
