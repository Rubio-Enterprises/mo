package backup

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type testData struct {
	Groups   map[string][]string `json:"groups"`
	Patterns map[string][]string `json:"patterns,omitempty"`
}

func TestSaveLoadRoundTrip(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	data := testData{
		Groups: map[string][]string{
			"default": {"/path/to/a.md", "/path/to/b.md"},
			"docs":    {"/path/to/c.md"},
		},
		Patterns: map[string][]string{
			"default": {"/path/to/*.md"},
		},
	}

	if err := Save(6275, data); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	if !Exists(6275) {
		t.Fatal("Exists returned false after Save")
	}

	var loaded testData
	if err := Load(6275, &loaded); err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	if len(loaded.Groups) != 2 {
		t.Fatalf("got %d groups, want 2", len(loaded.Groups))
	}
	if len(loaded.Groups["default"]) != 2 {
		t.Fatalf("got %d files in default group, want 2", len(loaded.Groups["default"]))
	}
	if loaded.Groups["default"][0] != "/path/to/a.md" {
		t.Fatalf("got %s, want /path/to/a.md", loaded.Groups["default"][0])
	}
	if len(loaded.Patterns["default"]) != 1 {
		t.Fatalf("got %d patterns, want 1", len(loaded.Patterns["default"]))
	}
}

func TestLoadNonExistent(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	var loaded testData
	if err := Load(9999, &loaded); err != nil {
		t.Fatalf("Load should return nil error for non-existent file, got: %v", err)
	}
	if len(loaded.Groups) != 0 {
		t.Fatalf("loaded data should be empty, got %v", loaded)
	}
}

func TestRemove(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	data := testData{
		Groups: map[string][]string{
			"default": {"/path/to/a.md"},
		},
	}
	if err := Save(6275, data); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	if err := Remove(6275); err != nil {
		t.Fatalf("Remove returned error: %v", err)
	}

	if Exists(6275) {
		t.Fatal("Exists returned true after Remove")
	}
}

func TestRemoveNonExistent(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	if err := Remove(9999); err != nil {
		t.Fatalf("Remove should return nil error for non-existent file, got: %v", err)
	}
}

func TestSaveOverwrite(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	data1 := testData{
		Groups: map[string][]string{
			"default": {"/path/to/a.md"},
		},
	}
	if err := Save(6275, data1); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	data2 := testData{
		Groups: map[string][]string{
			"default": {"/path/to/b.md", "/path/to/c.md"},
		},
	}
	if err := Save(6275, data2); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	var loaded testData
	if err := Load(6275, &loaded); err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(loaded.Groups["default"]) != 2 {
		t.Fatalf("got %d files, want 2", len(loaded.Groups["default"]))
	}
}

func TestPath(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", dir)

	p, err := Path(6275)
	if err != nil {
		t.Fatalf("Path returned error: %v", err)
	}

	want := dir + "/mo/backup/mo-6275.json"
	if p != want {
		t.Fatalf("got %s, want %s", p, want)
	}
}

func TestSaveCreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", dir)

	// Directory does not exist yet
	backupDir := dir + "/mo/backup"
	if _, err := os.Stat(backupDir); !os.IsNotExist(err) {
		t.Fatal("backup directory should not exist before Save")
	}

	data := testData{Groups: map[string][]string{"default": {"/a.md"}}}
	if err := Save(6275, data); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	if _, err := os.Stat(backupDir); err != nil {
		t.Fatalf("backup directory should exist after Save: %v", err)
	}
}

func TestDirUsesXDGStateHome(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_STATE_HOME", root)

	got, err := Dir()
	if err != nil {
		t.Fatalf("Dir returned error: %v", err)
	}
	want := filepath.Join(root, "mo", "backup")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestExistsFalseForMissing(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	if Exists(42) {
		t.Fatal("Exists should be false for non-existent backup")
	}
}

func TestLoadCorruptedJSONReturnsError(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", dir)

	p, err := Path(6275)
	if err != nil {
		t.Fatalf("Path returned error: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(p, []byte("{ this is not json"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	var loaded testData
	err = Load(6275, &loaded)
	if err == nil {
		t.Fatal("Load should return error for corrupted JSON")
	}
	if !strings.Contains(err.Error(), "unmarshal") {
		t.Fatalf("error should mention unmarshal: %v", err)
	}
}

func TestLoadReadErrorPropagated(t *testing.T) {
	// On unix systems, a directory at the file path makes ReadFile fail with
	// a non IsNotExist error so the error path is exercised.
	dir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", dir)

	p, err := Path(7777)
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	var loaded testData
	if err := Load(7777, &loaded); err == nil {
		t.Fatal("Load should return error when path is a directory")
	}
}

func TestSaveMarshalErrorReturnsError(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	// math.Inf is not representable in JSON, so json.Marshal fails.
	if err := Save(6275, math.Inf(1)); err == nil {
		t.Fatal("Save should return error for unmarshallable input")
	}
}

func TestSaveTempDirCreationFailureReturnsError(t *testing.T) {
	// Point XDG_STATE_HOME at a path inside a non-writable parent so MkdirAll fails.
	parent := t.TempDir()
	readonly := filepath.Join(parent, "ro")
	if err := os.Mkdir(readonly, 0o500); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	// Running as root bypasses permission checks; skip in that case.
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses permission errors")
	}
	t.Setenv("XDG_STATE_HOME", readonly)

	err := Save(6275, testData{Groups: map[string][]string{"default": {"/x.md"}}})
	if err == nil {
		t.Fatal("Save should fail when backup dir cannot be created")
	}
}

func TestRemovePropagatesNonNotExistError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses permission errors")
	}
	dir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", dir)

	// Create a backup file then make its parent dir read-only so Remove fails.
	backupDir := filepath.Join(dir, "mo", "backup")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupPath := filepath.Join(backupDir, "mo-555.json")
	if err := os.WriteFile(backupPath, []byte("{}"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Chmod(backupDir, 0o500); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(backupDir, 0o755); err != nil {
			t.Logf("chmod restore failed: %v", err)
		}
	})

	if err := Remove(555); err == nil {
		t.Fatal("expected Remove to fail when parent is read-only")
	}
}

func TestSaveTempFileCleanedUpOnFailure(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_STATE_HOME", root)

	// Pre-create the destination path as a non-empty directory so os.Rename
	// fails — Rename cannot replace a non-empty directory with a file.
	dest, err := Path(123)
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	// Put a file inside the destination dir so Rename definitely cannot
	// replace it (an empty directory can be replaced by Rename on some
	// platforms).
	if err := os.WriteFile(filepath.Join(dest, "sentinel"), []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile sentinel: %v", err)
	}

	data := testData{Groups: map[string][]string{"default": {"/a.md"}}}
	if err := Save(123, data); err == nil {
		t.Fatal("Save should fail when destination is a non-empty directory")
	}

	// Confirm the temp file was cleaned up — no mo-backup-*.tmp entries
	// should remain in the backup directory.
	backupDir := filepath.Dir(dest)
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "mo-backup-") {
			t.Fatalf("temp file %q should not remain after failed Save", e.Name())
		}
	}
}

func TestPathDeterministic(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	a, err := Path(123)
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	b, err := Path(123)
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if a != b {
		t.Fatalf("Path should be deterministic, got %q and %q", a, b)
	}
	if !strings.Contains(a, "mo-123.json") {
		t.Fatalf("Path should contain the port number, got %q", a)
	}
}
