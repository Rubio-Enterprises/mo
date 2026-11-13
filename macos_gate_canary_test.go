package main

import (
	"runtime"
	"testing"
)

func TestMacOSGateCanary(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Fatal("intentional macos-only gate canary")
	}
}
