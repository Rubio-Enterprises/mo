package token

import (
	"os"
	"runtime"
	"testing"
)

func TestGenerateUnique(t *testing.T) {
	a, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	b, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	if a == "" || b == "" {
		t.Fatal("Generate returned empty token")
	}
	if len(a) != 64 { // 32 bytes hex-encoded
		t.Fatalf("token length = %d, want 64", len(a))
	}
	if a == b {
		t.Fatal("Generate returned identical tokens")
	}
}

func TestSaveLoadRemove(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	const port = 6275

	// Load with no file present returns empty, no error.
	got, err := Load(port)
	if err != nil {
		t.Fatalf("Load (missing) error: %v", err)
	}
	if got != "" {
		t.Fatalf("Load (missing) = %q, want empty", got)
	}

	tok, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	if err := Save(port, tok); err != nil {
		t.Fatalf("Save error: %v", err)
	}

	got, err = Load(port)
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if got != tok {
		t.Fatalf("Load = %q, want %q", got, tok)
	}

	// File must be owner-only (skip the bit check on Windows, where Unix perms
	// don't apply).
	if runtime.GOOS != "windows" {
		p, err := Path(port)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("token file perm = %o, want 600", perm)
		}
	}

	if err := Remove(port); err != nil {
		t.Fatalf("Remove error: %v", err)
	}
	got, err = Load(port)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("Load after Remove = %q, want empty", got)
	}
	// Remove is idempotent.
	if err := Remove(port); err != nil {
		t.Fatalf("Remove (missing) error: %v", err)
	}
}
