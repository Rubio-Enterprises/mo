package xdg

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateHomeUsesEnvWhenSet(t *testing.T) {
	want := "/custom/state/path"
	t.Setenv("XDG_STATE_HOME", want)

	got, err := StateHome()
	if err != nil {
		t.Fatalf("StateHome returned error: %v", err)
	}
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestStateHomeFallsBackToHomeDir(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "")

	got, err := StateHome()
	if err != nil {
		t.Fatalf("StateHome returned error: %v", err)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir failed: %v", err)
	}
	want := filepath.Join(home, ".local", "state")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestStateHomePrefersEnvOverHomeDir(t *testing.T) {
	// Even with HOME set, XDG_STATE_HOME should win.
	t.Setenv("HOME", "/tmp/should-not-be-used")
	t.Setenv("XDG_STATE_HOME", "/explicit/override")

	got, err := StateHome()
	if err != nil {
		t.Fatalf("StateHome returned error: %v", err)
	}
	if got != "/explicit/override" {
		t.Fatalf("got %q, want /explicit/override", got)
	}
}

func TestStateHomeEmptyEnvFallsThrough(t *testing.T) {
	// Empty string env should be treated as unset.
	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("HOME", "/tmp/fake-home")

	got, err := StateHome()
	if err != nil {
		t.Fatalf("StateHome returned error: %v", err)
	}
	want := filepath.Join("/tmp/fake-home", ".local", "state")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
