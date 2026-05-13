package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/k1LoW/mo/internal/server"
)

// stdoutMu and stderrMu serialize swaps of os.Stdout / os.Stderr by the capture
// helpers so the global FD state is mutated atomically with respect to other
// invocations, even when one of them runs in a goroutine (see captureStdout /
// captureStderr). Separate mutexes are used so that nesting captureStdout
// inside captureStderr (and vice versa) does not deadlock.
var (
	stdoutMu sync.Mutex
	stderrMu sync.Mutex
)

func newTCPListener() (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:0")
}

func waitForServerUp(addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 200 * time.Millisecond}
	for time.Now().Before(deadline) {
		resp, err := client.Get(fmt.Sprintf("http://%s/_/api/status", addr))
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("server on %s did not come up", addr)
}

// captureStdout swaps os.Stdout for an os.Pipe, runs fn, and returns whatever
// was written. Helpful for asserting on text/JSON output.
//
// The package-level stdMu lock makes the swap-and-restore atomic with respect
// to any other capture helper invocation, so tests can safely run these from
// goroutines without racing on os.Stdout/os.Stderr.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = orig }()

	fn()
	w.Close()

	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r); err != nil {
		t.Fatalf("read: %v", err)
	}
	return buf.String()
}

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	stderrMu.Lock()
	defer stderrMu.Unlock()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	orig := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = orig }()

	fn()
	w.Close()

	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r); err != nil {
		t.Fatalf("read: %v", err)
	}
	return buf.String()
}

func TestHasGlobChars(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"*.md", true},
		{"docs/?.md", true},
		{"[abc]", true},
		{"README.md", false},
		{"", false},
		{"path/with/no/wildcard.md", false},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			if got := hasGlobChars(c.in); got != c.want {
				t.Fatalf("hasGlobChars(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestResolveFiles(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.md")
	if err := os.WriteFile(a, []byte("# A"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	t.Run("returns nil for empty input", func(t *testing.T) {
		got, err := resolveFiles(nil)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if got != nil {
			t.Fatalf("got %v, want nil", got)
		}
	})

	t.Run("resolves existing file to absolute path", func(t *testing.T) {
		got, err := resolveFiles([]string{a})
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if len(got) != 1 || !filepath.IsAbs(got[0]) {
			t.Fatalf("got %v, want one absolute path", got)
		}
	})

	t.Run("missing file returns error", func(t *testing.T) {
		_, err := resolveFiles([]string{filepath.Join(dir, "missing.md")})
		if err == nil {
			t.Fatal("expected error for missing file")
		}
		if !strings.Contains(err.Error(), "file not found") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("directory returns error", func(t *testing.T) {
		_, err := resolveFiles([]string{dir})
		if err == nil {
			t.Fatal("expected error for directory")
		}
		if !strings.Contains(err.Error(), "is a directory") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestLoadRestoreData(t *testing.T) {
	t.Run("returns parsed data and removes the file", func(t *testing.T) {
		dir := t.TempDir()
		p := filepath.Join(dir, "restore.json")
		rd := server.RestoreData{
			Groups:   map[string][]string{"default": {"/a.md"}},
			Patterns: map[string][]string{"default": {"/*.md"}},
		}
		b, err := json.Marshal(rd)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}

		groups, patterns, _, _, err := loadRestoreData(p)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if len(groups["default"]) != 1 || groups["default"][0] != "/a.md" {
			t.Fatalf("got groups %v", groups)
		}
		if len(patterns["default"]) != 1 || patterns["default"][0] != "/*.md" {
			t.Fatalf("got patterns %v", patterns)
		}
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("restore file should be removed after read, stat err: %v", err)
		}
	})

	t.Run("non-existent path returns error", func(t *testing.T) {
		_, _, _, _, err := loadRestoreData("/no/such/file.json")
		if err == nil {
			t.Fatal("expected error for missing file")
		}
	})

	t.Run("corrupted JSON returns error", func(t *testing.T) {
		dir := t.TempDir()
		p := filepath.Join(dir, "restore.json")
		if err := os.WriteFile(p, []byte("not json"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		_, _, _, _, err := loadRestoreData(p)
		if err == nil {
			t.Fatal("expected unmarshal error")
		}
	})
}

func TestProbeServer(t *testing.T) {
	t.Run("returns groups when status is healthy", func(t *testing.T) {
		srv := newFakeMoServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version": "v1.0",
				"pid":     42,
				"groups":  []map[string]any{{"name": "default"}, {"name": "docs"}},
			})
		})
		addr := strings.TrimPrefix(srv.URL, "http://")

		got, err := probeServer(addr)
		if err != nil {
			t.Fatalf("probe: %v", err)
		}
		if got.client == nil {
			t.Fatal("client should not be nil")
		}
		if len(got.groups) != 2 || got.groups[0] != "default" || got.groups[1] != "docs" {
			t.Fatalf("got groups %v", got.groups)
		}
	})

	t.Run("returns error when status returns non-200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		t.Cleanup(srv.Close)
		addr := strings.TrimPrefix(srv.URL, "http://")

		if _, err := probeServer(addr); err == nil {
			t.Fatal("expected error for 500 response")
		}
	})

	t.Run("returns error when response missing version", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"pid": 1}`))
		}))
		t.Cleanup(srv.Close)
		addr := strings.TrimPrefix(srv.URL, "http://")

		if _, err := probeServer(addr); err == nil {
			t.Fatal("expected error for missing version")
		}
	})

	t.Run("returns error when no server", func(t *testing.T) {
		if _, err := probeServer("127.0.0.1:1"); err == nil {
			t.Fatal("expected connection error")
		}
	})
}

func newFullFakeServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// statusJSON encodes a minimal status response for the fake server.
func statusJSON(groups []map[string]any) []byte {
	resp := map[string]any{
		"version": "test",
		"pid":     1,
		"groups":  groups,
	}
	b, _ := json.Marshal(resp)
	return b
}

func TestDoShutdownAndDoRestart(t *testing.T) {
	for _, tc := range []struct {
		name     string
		path     string
		callFn   func(addr string) error
		wantText string
	}{
		{"shutdown", "/_/api/shutdown", func(addr string) error { return doShutdown(addr) }, "shutdown request sent"},
		{"restart", "/_/api/restart", func(addr string) error { return doRestart(addr) }, "restart request sent"},
	} {
		t.Run(tc.name+" happy path", func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
				w.Write(statusJSON(nil)) //nolint:errcheck
			})
			mux.HandleFunc(tc.path, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusAccepted)
			})
			srv := newFullFakeServer(t, mux)
			addr := strings.TrimPrefix(srv.URL, "http://")

			err := captureStderrErr(t, func() error { return tc.callFn(addr) })
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})

		t.Run(tc.name+" unexpected status returns error", func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
				w.Write(statusJSON(nil)) //nolint:errcheck
			})
			mux.HandleFunc(tc.path, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
			})
			srv := newFullFakeServer(t, mux)
			addr := strings.TrimPrefix(srv.URL, "http://")

			err := captureStderrErr(t, func() error { return tc.callFn(addr) })
			if err == nil || !strings.Contains(err.Error(), "unexpected response") {
				t.Fatalf("expected unexpected-response error, got %v", err)
			}
		})

		t.Run(tc.name+" no server returns probe error", func(t *testing.T) {
			err := tc.callFn("127.0.0.1:1")
			if err == nil {
				t.Fatal("expected probe error")
			}
		})
	}
}

// captureStderrErr is like captureStderr but for funcs that return an error.
func captureStderrErr(t *testing.T, fn func() error) error {
	t.Helper()
	var fnErr error
	captureStderr(t, func() {
		fnErr = fn()
	})
	return fnErr
}

func TestPostFiles(t *testing.T) {
	t.Run("success returns deeplink entry", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/files", func(w http.ResponseWriter, r *http.Request) {
			defer r.Body.Close()
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["path"] != "/a.md" || body["group"] != "default" {
				t.Errorf("unexpected body: %v", body)
			}
			_ = json.NewEncoder(w).Encode(server.FileEntry{ID: "id1", Path: "/a.md"})
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		entries := postFiles(srv.Client(), addr, "default", []string{"/a.md"})
		if len(entries) != 1 {
			t.Fatalf("got %d entries, want 1", len(entries))
		}
		if !strings.HasSuffix(entries[0].URL, "file=id1") {
			t.Fatalf("unexpected URL: %s", entries[0].URL)
		}
		if entries[0].Path != "/a.md" {
			t.Fatalf("got path %q", entries[0].Path)
		}
	})

	t.Run("non-200 response skips entry", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/files", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		entries := postFiles(srv.Client(), addr, "default", []string{"/a.md"})
		if len(entries) != 0 {
			t.Fatalf("got %d entries, want 0", len(entries))
		}
	})

	t.Run("transport error skips entry", func(t *testing.T) {
		entries := postFiles(&http.Client{}, "127.0.0.1:1", "default", []string{"/a.md"})
		if len(entries) != 0 {
			t.Fatalf("got %d entries, want 0", len(entries))
		}
	})
}

func TestPostPatterns(t *testing.T) {
	t.Run("success returns one entry per file in pattern", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/patterns", func(w http.ResponseWriter, r *http.Request) {
			defer r.Body.Close()
			_ = json.NewEncoder(w).Encode(server.AddPatternResponse{
				Files: []*server.FileEntry{
					{ID: "id1", Path: "/a.md"},
					{ID: "id2", Path: "/b.md"},
				},
			})
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		entries := postPatterns(srv.Client(), addr, "default", []string{"/*.md"})
		if len(entries) != 2 {
			t.Fatalf("got %d entries, want 2", len(entries))
		}
	})

	t.Run("transport error returns nil entries", func(t *testing.T) {
		entries := postPatterns(&http.Client{}, "127.0.0.1:1", "default", []string{"/*.md"})
		if len(entries) != 0 {
			t.Fatalf("got %d entries, want 0", len(entries))
		}
	})

	t.Run("non-200 response skips entry", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/patterns", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		entries := postPatterns(srv.Client(), addr, "default", []string{"/*.md"})
		if len(entries) != 0 {
			t.Fatalf("got %d entries, want 0", len(entries))
		}
	})
}

func TestTryAddToExisting(t *testing.T) {
	t.Run("returns false when no server", func(t *testing.T) {
		got := tryAddToExisting("127.0.0.1:1", []string{"/a.md"}, nil)
		if got {
			t.Fatal("expected false when no server")
		}
	})

	t.Run("returns true and posts files to existing server", func(t *testing.T) {
		var postedFiles int
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
			w.Write(statusJSON([]map[string]any{{"name": "default"}})) //nolint:errcheck
		})
		mux.HandleFunc("/_/api/files", func(w http.ResponseWriter, r *http.Request) {
			postedFiles++
			_ = json.NewEncoder(w).Encode(server.FileEntry{ID: "id1", Path: "/a.md"})
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		// Force no browser
		prev := noOpen
		noOpen = true
		prevTarget := target
		target = "default"
		t.Cleanup(func() {
			noOpen = prev
			target = prevTarget
		})

		captureStderr(t, func() {
			captureStdout(t, func() {
				got := tryAddToExisting(addr, []string{"/a.md"}, nil)
				if !got {
					t.Fatal("expected true")
				}
			})
		})
		if postedFiles != 1 {
			t.Fatalf("expected 1 file POST, got %d", postedFiles)
		}
	})
}

func TestDoUnwatch(t *testing.T) {
	t.Run("happy path returns no error", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
			w.Write(statusJSON(nil)) //nolint:errcheck
		})
		mux.HandleFunc("/_/api/patterns", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodDelete {
				t.Errorf("unexpected method: %s", r.Method)
			}
			w.WriteHeader(http.StatusNoContent)
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		var err error
		captureStderr(t, func() {
			err = doUnwatch(addr, []string{"/*.md"}, "default")
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("404 response returns descriptive error", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
			w.Write(statusJSON(nil)) //nolint:errcheck
		})
		mux.HandleFunc("/_/api/patterns", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		err := doUnwatch(addr, []string{"/*.md"}, "default")
		if err == nil || !strings.Contains(err.Error(), "not found") {
			t.Fatalf("expected not-found error, got %v", err)
		}
	})

	t.Run("unexpected status returns error", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
			w.Write(statusJSON(nil)) //nolint:errcheck
		})
		mux.HandleFunc("/_/api/patterns", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		err := doUnwatch(addr, []string{"/*.md"}, "default")
		if err == nil || !strings.Contains(err.Error(), "unexpected response") {
			t.Fatalf("expected unexpected-response error, got %v", err)
		}
	})

	t.Run("no server returns probe error", func(t *testing.T) {
		err := doUnwatch("127.0.0.1:1", []string{"/*.md"}, "default")
		if err == nil {
			t.Fatal("expected probe error")
		}
	})
}

func TestDoClose(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.md")
	if err := os.WriteFile(a, []byte("# A"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	statusBody := func() []byte {
		return statusJSON([]map[string]any{
			{
				"name": "default",
				"files": []map[string]any{
					{"id": "id1", "path": a, "name": filepath.Base(a)},
				},
			},
		})
	}

	t.Run("happy path returns closed paths", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
			w.Write(statusBody()) //nolint:errcheck
		})
		mux.HandleFunc("/_/api/files/id1", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodDelete {
				t.Errorf("unexpected method: %s", r.Method)
			}
			w.WriteHeader(http.StatusNoContent)
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		paths, err := doClose(addr, []string{a}, "default")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(paths) != 1 || paths[0] != a {
			t.Fatalf("got %v, want [%s]", paths, a)
		}
	})

	t.Run("file not in group returns aggregated error", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
			w.Write(statusBody()) //nolint:errcheck
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		paths, err := doClose(addr, []string{filepath.Join(dir, "missing.md")}, "default")
		if err == nil {
			t.Fatal("expected error")
		}
		if len(paths) != 0 {
			t.Fatalf("got %d closed, want 0", len(paths))
		}
	})

	t.Run("no server returns error", func(t *testing.T) {
		_, err := doClose("127.0.0.1:1", []string{a}, "default")
		if err == nil {
			t.Fatal("expected probe error")
		}
	})

	t.Run("404 on delete returns error", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
			w.Write(statusBody()) //nolint:errcheck
		})
		mux.HandleFunc("/_/api/files/id1", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		})
		srv := newFullFakeServer(t, mux)
		addr := strings.TrimPrefix(srv.URL, "http://")

		_, err := doClose(addr, []string{a}, "default")
		if err == nil {
			t.Fatal("expected error from 404")
		}
	})
}

func TestPrintDeeplinks(t *testing.T) {
	t.Run("empty entries prints nothing", func(t *testing.T) {
		out := captureStdout(t, func() {
			printDeeplinks(nil)
		})
		if out != "" {
			t.Fatalf("expected empty output, got %q", out)
		}
	})

	t.Run("prints URL and name", func(t *testing.T) {
		out := captureStdout(t, func() {
			printDeeplinks([]deeplinkEntry{
				{URL: "http://localhost/?file=abc", Path: "/x/README.md"},
			})
		})
		if !strings.Contains(out, "http://localhost/?file=abc") || !strings.Contains(out, "README.md") {
			t.Fatalf("unexpected output: %q", out)
		}
	})
}

func TestEmitServeOutputEmpty(t *testing.T) {
	t.Run("json mode with no entries emits empty Files array", func(t *testing.T) {
		jsonOutput = true
		defer func() { jsonOutput = false }()

		out := captureStdout(t, func() {
			emitServeOutput("localhost:6275", nil, true)
		})
		var got jsonServeOutput
		if err := json.Unmarshal([]byte(out), &got); err != nil {
			t.Fatalf("invalid JSON: %v\n%s", err, out)
		}
		if got.URL != "http://localhost:6275" {
			t.Fatalf("got URL %q", got.URL)
		}
		if got.Files == nil {
			t.Fatalf("Files should be non-nil empty slice")
		}
		if len(got.Files) != 0 {
			t.Fatalf("Files should be empty, got %d", len(got.Files))
		}
	})
}

func TestWriteJSON(t *testing.T) {
	out := captureStdout(t, func() {
		writeJSON(map[string]string{"hello": "world"})
	})
	var got map[string]string
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, out)
	}
	if got["hello"] != "world" {
		t.Fatalf("got %v", got)
	}
	// Indented output should contain newline.
	if !strings.Contains(out, "\n") {
		t.Fatalf("output should be indented:\n%s", out)
	}
}

// startStatusServer starts a fake mo HTTP server that responds to /_/api/status
// with the given status payload. It also writes a fake log file so discoverPorts
// surfaces this port. The port chosen by httptest is used.
func startStatusServerOnLogPort(t *testing.T, status statusResponse) (port int) {
	t.Helper()
	// Listen on a chosen ephemeral port via httptest.
	mux := http.NewServeMux()
	mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(status)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	// Extract port.
	addr := strings.TrimPrefix(srv.URL, "http://")
	_, p, err := splitHostPort(addr)
	if err != nil {
		t.Fatalf("splitHostPort: %v", err)
	}

	// Create a fake log file so discoverPorts picks up this port.
	dir, err := logfileDir()
	if err != nil {
		t.Fatalf("logfileDir: %v", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("mo-%d.log", p)), nil, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// doStatus connects to localhost:PORT — httptest binds to 127.0.0.1 so this works.
	return p
}

// splitHostPort wraps net.SplitHostPort and parses the port to int.
func splitHostPort(addr string) (host string, port int, err error) {
	h, p, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0, err
	}
	pi, err := strconv.Atoi(p)
	if err != nil {
		return "", 0, err
	}
	return h, pi, nil
}

// logfileDir returns the same path logfile.Dir() returns by reading XDG.
func logfileDir() (string, error) {
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		return "", fmt.Errorf("XDG_STATE_HOME not set")
	}
	return filepath.Join(state, "mo", "log"), nil
}

func TestDoStatusWithRunningServer(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	status := statusResponse{
		Version:  "v1.0",
		Revision: "abc1234",
		PID:      99,
	}
	status.Groups = []struct {
		Name  string `json:"name"`
		Files []struct {
			Name string `json:"name"`
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"files"`
		Patterns []string `json:"patterns,omitempty"`
	}{
		{
			Name: "default",
			Files: []struct {
				Name string `json:"name"`
				ID   string `json:"id"`
				Path string `json:"path"`
			}{{Name: "a.md", ID: "id1", Path: "/a.md"}},
			Patterns: []string{"/some/*.md"},
		},
	}

	startStatusServerOnLogPort(t, status)

	t.Run("text mode prints groups, files, and patterns", func(t *testing.T) {
		jsonOutput = false
		out := captureStdout(t, func() {
			if err := doStatus(); err != nil {
				t.Fatalf("doStatus: %v", err)
			}
		})
		// httptest binds to 127.0.0.1 but doStatus uses "localhost" — connect should still succeed.
		if !strings.Contains(out, "pid 99") {
			t.Fatalf("expected pid in output, got %q", out)
		}
		if !strings.Contains(out, "default: 1 file") {
			t.Fatalf("expected group line, got %q", out)
		}
		if !strings.Contains(out, "watching: /some/*.md") {
			t.Fatalf("expected pattern line, got %q", out)
		}
	})

	t.Run("json mode emits a JSON array", func(t *testing.T) {
		jsonOutput = true
		defer func() { jsonOutput = false }()
		out := captureStdout(t, func() {
			if err := doStatus(); err != nil {
				t.Fatalf("doStatus: %v", err)
			}
		})
		var entries []jsonStatusEntry
		if err := json.Unmarshal([]byte(out), &entries); err != nil {
			t.Fatalf("invalid JSON: %v\n%s", err, out)
		}
		if len(entries) != 1 {
			t.Fatalf("got %d entries, want 1", len(entries))
		}
		if entries[0].Status != "running" {
			t.Fatalf("got status %q, want running", entries[0].Status)
		}
		if entries[0].PID != 99 {
			t.Fatalf("got PID %d, want 99", entries[0].PID)
		}
		if len(entries[0].Groups) != 1 || entries[0].Groups[0].Name != "default" {
			t.Fatalf("got groups %v", entries[0].Groups)
		}
	})
}

func TestDoStatusNoServer(t *testing.T) {
	// Point XDG_STATE_HOME at an empty temp dir so discoverPorts returns nil.
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	t.Run("text mode prints no-server message", func(t *testing.T) {
		jsonOutput = false
		out := captureStderr(t, func() {
			if err := doStatus(); err != nil {
				t.Fatalf("doStatus: %v", err)
			}
		})
		if !strings.Contains(out, "no mo server found") {
			t.Fatalf("expected no-server message, got %q", out)
		}
	})

	t.Run("json mode emits empty array", func(t *testing.T) {
		jsonOutput = true
		defer func() { jsonOutput = false }()
		out := captureStdout(t, func() {
			if err := doStatus(); err != nil {
				t.Fatalf("doStatus: %v", err)
			}
		})
		var got []jsonStatusEntry
		if err := json.Unmarshal([]byte(out), &got); err != nil {
			t.Fatalf("invalid JSON: %v\n%s", err, out)
		}
		if got == nil || len(got) != 0 {
			t.Fatalf("expected empty array, got %v", got)
		}
	})
}

func TestDiscoverPorts(t *testing.T) {
	t.Run("returns sorted unique ports from log file names", func(t *testing.T) {
		state := t.TempDir()
		t.Setenv("XDG_STATE_HOME", state)

		logDir := filepath.Join(state, "mo", "log")
		if err := os.MkdirAll(logDir, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"mo-6275.log", "mo-7000.log", "mo-6275.log.1", "junk.txt", "mo-bad.log"} {
			if err := os.WriteFile(filepath.Join(logDir, name), nil, 0o600); err != nil {
				t.Fatal(err)
			}
		}

		ports := discoverPorts()
		if len(ports) != 2 || ports[0] != 6275 || ports[1] != 7000 {
			t.Fatalf("got %v, want [6275 7000]", ports)
		}
	})

	t.Run("missing dir returns nil", func(t *testing.T) {
		t.Setenv("XDG_STATE_HOME", t.TempDir())
		if ports := discoverPorts(); ports != nil {
			t.Fatalf("got %v, want nil", ports)
		}
	})
}

func TestRun_StatusFlag(t *testing.T) {
	// With no servers, --status should not error. We run in foreground=true so
	// no log file is created in the throwaway XDG_STATE_HOME; doStatus then
	// sees no log directory and prints the no-server message.
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	statusServer = true
	prevForeground := foreground
	foreground = true
	defer func() {
		statusServer = false
		foreground = prevForeground
	}()

	out := captureStderr(t, func() {
		if err := run(rootCmd, nil); err != nil {
			t.Fatalf("run --status: %v", err)
		}
	})
	if !strings.Contains(out, "no mo server found") {
		t.Fatalf("expected no-server message, got %q", out)
	}
}

func TestRun_ShutdownFlagNoServer(t *testing.T) {
	prevShutdown, prevPort, prevBind := shutdownServer, port, bind
	t.Cleanup(func() {
		shutdownServer = prevShutdown
		port = prevPort
		bind = prevBind
	})
	shutdownServer = true
	port = 1 // tiny, unlikely-listened port
	bind = "127.0.0.1"

	err := run(rootCmd, nil)
	if err == nil {
		t.Fatal("expected error when no server is running")
	}
	if !strings.Contains(err.Error(), "no mo server") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRun_RestartFlagNoServer(t *testing.T) {
	prevRestart, prevPort, prevBind := restartServer, port, bind
	t.Cleanup(func() {
		restartServer = prevRestart
		port = prevPort
		bind = prevBind
	})
	restartServer = true
	port = 1
	bind = "127.0.0.1"

	err := run(rootCmd, nil)
	if err == nil {
		t.Fatal("expected error when no server is running")
	}
}

func TestRun_UnwatchInvalidTarget(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	unwatchPatterns = []string{"**/*.md"}
	prev := target
	target = "bad?name" // contains '?' which is reserved
	prevForeground := foreground
	foreground = true
	defer func() {
		unwatchPatterns = nil
		target = prev
		foreground = prevForeground
	}()

	err := run(rootCmd, nil)
	if err == nil {
		t.Fatal("expected error for invalid group name")
	}
	if !strings.Contains(err.Error(), "invalid target group name") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRun_CloseInvalidTarget(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	closeFiles = true
	prev := target
	target = "bad?name"
	prevForeground := foreground
	foreground = true
	defer func() {
		closeFiles = false
		target = prev
		foreground = prevForeground
	}()

	err := run(rootCmd, []string{"README.md"})
	if err == nil {
		t.Fatal("expected error for invalid group name")
	}
	if !strings.Contains(err.Error(), "invalid target group name") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRun_RestoreCorrupted(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	dir := t.TempDir()
	p := filepath.Join(dir, "restore.json")
	if err := os.WriteFile(p, []byte("bad json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	prev := restore
	restore = p
	foregroundPrev := foreground
	foreground = true
	defer func() {
		restore = prev
		foreground = foregroundPrev
	}()

	err := run(rootCmd, nil)
	if err == nil {
		t.Fatal("expected error from corrupted restore data")
	}
	if !strings.Contains(err.Error(), "failed to restore state") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRun_InvalidTargetWithNoFiles(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	prevTarget, prevForeground, prevPort, prevBind := target, foreground, port, bind
	t.Cleanup(func() {
		target = prevTarget
		foreground = prevForeground
		port = prevPort
		bind = prevBind
	})
	target = "bad?name"
	foreground = true
	port = 1
	bind = "127.0.0.1"

	err := run(rootCmd, nil)
	if err == nil {
		t.Fatal("expected error for invalid group name")
	}
	if !strings.Contains(err.Error(), "invalid target group name") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRun_ClearNoBackupNoServer(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	prevClear, prevForeground, prevPort, prevBind := clearBackup, foreground, port, bind
	t.Cleanup(func() {
		clearBackup = prevClear
		foreground = prevForeground
		port = prevPort
		bind = prevBind
	})
	clearBackup = true
	foreground = true
	port = 65535 // unlikely to be in use
	bind = "127.0.0.1"

	out := captureStderr(t, func() {
		if err := run(rootCmd, nil); err != nil {
			t.Fatalf("run --clear: %v", err)
		}
	})
	if !strings.Contains(out, "no saved session") {
		t.Fatalf("expected no-saved-session message, got %q", out)
	}
}

func TestRun_OpenBrowserWhenServerAlreadyRunning(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	mux := http.NewServeMux()
	mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": "test",
			"pid":     1,
			"groups":  []map[string]any{{"name": "default"}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, p, err := splitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatalf("splitHostPort: %v", err)
	}

	prevPort := port
	prevBind := bind
	prevNoOpen := noOpen
	prevForeground := foreground
	prevTarget := target
	port = p
	bind = "127.0.0.1"
	noOpen = true // do not actually open a browser
	foreground = true
	target = "default"
	defer func() {
		port = prevPort
		bind = prevBind
		noOpen = prevNoOpen
		foreground = prevForeground
		target = prevTarget
	}()

	// With no files and no patterns, run should detect the existing server,
	// (would normally) open the browser, and return without error.
	if err := run(rootCmd, nil); err != nil {
		t.Fatalf("run: %v", err)
	}
}

func TestOpenBrowserNoOpen(t *testing.T) {
	prev := noOpen
	noOpen = true
	defer func() { noOpen = prev }()
	// Should not panic, should not invoke browser package.
	openBrowser("localhost:6275")
}

// findFreePort asks the OS for an unused TCP port and returns it.
// The listener is closed before returning so the port is free for the caller.
func findFreePort(t *testing.T) int {
	t.Helper()
	ln, err := newTCPListener()
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	addr := ln.Addr().String()
	_, p, err := splitHostPort(addr)
	if err != nil {
		t.Fatalf("splitHostPort: %v", err)
	}
	return p
}

func TestStartServerLifecycle(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	// Create one real file so AddFile succeeds.
	dir := t.TempDir()
	f := filepath.Join(dir, "a.md")
	if err := os.WriteFile(f, []byte("# A"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	prevNoOpen := noOpen
	prevPort := port
	prevJSON := jsonOutput
	noOpen = true
	jsonOutput = false
	p := findFreePort(t)
	port = p
	addr := fmt.Sprintf("127.0.0.1:%d", p)
	defer func() {
		noOpen = prevNoOpen
		port = prevPort
		jsonOutput = prevJSON
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		// Suppress stdout/stderr from the serving output during the test.
		captureStdout(t, func() {
			captureStderr(t, func() {
				done <- startServer(ctx, addr,
					map[string][]string{"default": {f}},
					nil, nil, nil)
			})
		})
	}()

	if err := waitForServerUp(addr, 5*time.Second); err != nil {
		t.Fatalf("server did not come up: %v", err)
	}

	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("startServer returned: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("startServer did not return after context cancel")
	}
}

func TestStartServerListenError(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	// Bind another listener to occupy the port; startServer should fail to listen.
	ln, err := newTCPListener()
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	addr := ln.Addr().String()

	prevNoOpen := noOpen
	noOpen = true
	defer func() { noOpen = prevNoOpen }()

	dir := t.TempDir()
	f := filepath.Join(dir, "a.md")
	if err := os.WriteFile(f, []byte("# A"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = captureStderrErr(t, func() error {
		return startServer(ctx, addr,
			map[string][]string{"default": {f}},
			nil, nil, nil)
	})
	if err == nil {
		t.Fatal("expected listen error, got nil")
	}
	if !strings.Contains(err.Error(), "cannot listen") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestStartServerAllFilesSkipped(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	prevNoOpen := noOpen
	noOpen = true
	defer func() { noOpen = prevNoOpen }()

	// Use a directory path so AddFile fails on read.
	dir := t.TempDir()

	addr := fmt.Sprintf("127.0.0.1:%d", findFreePort(t))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := captureStderrErr(t, func() error {
		return startServer(ctx, addr,
			map[string][]string{"default": {dir}},
			nil, nil, nil)
	})
	if err == nil {
		t.Fatal("expected error when all files are skipped")
	}
	if !strings.Contains(err.Error(), "skipped") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestWaitForReadyTimeout(t *testing.T) {
	// No server at this port: should timeout.
	_, err := waitForReady(fmt.Sprintf("127.0.0.1:%d", findFreePort(t)), 200*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !strings.Contains(err.Error(), "did not become ready") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestWaitForReadyHappyPath(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"version": "v1", "pid": 1, "groups": []any{}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")

	status, err := waitForReady(addr, 2*time.Second)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status == nil {
		t.Fatal("expected non-nil status")
	}
	if status.Version != "v1" {
		t.Fatalf("got version %q", status.Version)
	}
}

func TestRun_RestoreHappyPath(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	dir := t.TempDir()
	mdFile := filepath.Join(dir, "a.md")
	if err := os.WriteFile(mdFile, []byte("# A"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Write a valid restore file. loadRestoreData removes it after read.
	restoreFile := filepath.Join(dir, "restore.json")
	rd := server.RestoreData{
		Groups:   map[string][]string{"default": {mdFile}},
		Patterns: nil,
	}
	b, err := json.Marshal(rd)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(restoreFile, b, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	prevForeground := foreground
	prevRestore := restore
	prevPort := port
	prevBind := bind
	prevNoOpen := noOpen
	foreground = true
	restore = restoreFile
	port = findFreePort(t)
	bind = "127.0.0.1"
	noOpen = true
	defer func() {
		foreground = prevForeground
		restore = prevRestore
		port = prevPort
		bind = prevBind
		noOpen = prevNoOpen
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rootCmd.SetContext(ctx)

	done := make(chan error, 1)
	go func() {
		captureStdout(t, func() {
			captureStderr(t, func() {
				done <- run(rootCmd, nil)
			})
		})
	}()

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	if err := waitForServerUp(addr, 4*time.Second); err != nil {
		t.Fatalf("server did not start: %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run --restore returned: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run did not return after context cancel")
	}
}

func TestRun_TryAddToExistingViaRun(t *testing.T) {
	// Spin up a fake mo server, then run() should detect it and POST a file.
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	dir := t.TempDir()
	mdFile := filepath.Join(dir, "x.md")
	if err := os.WriteFile(mdFile, []byte("# X"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	var seenPath string
	mux := http.NewServeMux()
	mux.HandleFunc("/_/api/status", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": "test",
			"pid":     1,
			"groups":  []map[string]any{{"name": "default"}},
		})
	})
	mux.HandleFunc("/_/api/files", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		seenPath = body["path"]
		_ = json.NewEncoder(w).Encode(server.FileEntry{ID: "abc", Path: body["path"]})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	_, p, err := splitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatalf("splitHostPort: %v", err)
	}

	prevPort := port
	prevBind := bind
	prevNoOpen := noOpen
	prevForeground := foreground
	prevTarget := target
	port = p
	bind = "127.0.0.1"
	noOpen = true
	foreground = true
	target = "default"
	defer func() {
		port = prevPort
		bind = prevBind
		noOpen = prevNoOpen
		foreground = prevForeground
		target = prevTarget
	}()

	captureStdout(t, func() {
		captureStderr(t, func() {
			if err := run(rootCmd, []string{mdFile}); err != nil {
				t.Fatalf("run: %v", err)
			}
		})
	})

	if seenPath != mdFile {
		t.Fatalf("expected the fake server to receive %q, got %q", mdFile, seenPath)
	}
}

func TestRun_FilesValidationErrorPropagates(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	prevForeground := foreground
	foreground = true
	prevPort := port
	port = findFreePort(t)
	prevBind := bind
	bind = "127.0.0.1"
	prevNoOpen := noOpen
	noOpen = true
	defer func() {
		foreground = prevForeground
		port = prevPort
		bind = prevBind
		noOpen = prevNoOpen
	}()

	err := run(rootCmd, []string{"/definitely/not/a/file/here.md"})
	if err == nil {
		t.Fatal("expected error for missing file")
	}
	if !strings.Contains(err.Error(), "file not found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRun_PatternResolutionErrorPropagates(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	prevForeground := foreground
	foreground = true
	prevWatch := watchPatterns
	watchPatterns = []string{"non-glob-pattern.md"}
	prevPort := port
	port = findFreePort(t)
	prevBind := bind
	bind = "127.0.0.1"
	prevNoOpen := noOpen
	noOpen = true
	defer func() {
		foreground = prevForeground
		watchPatterns = prevWatch
		port = prevPort
		bind = prevBind
		noOpen = prevNoOpen
	}()

	err := run(rootCmd, nil)
	if err == nil {
		t.Fatal("expected error for non-glob pattern")
	}
	if !strings.Contains(err.Error(), "does not contain glob characters") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRun_ClearWithBackupNoServer(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateDir)

	prevClear, prevForeground, prevBind, prevPort := clearBackup, foreground, bind, port
	origStdin := os.Stdin
	t.Cleanup(func() {
		clearBackup = prevClear
		foreground = prevForeground
		bind = prevBind
		port = prevPort
		os.Stdin = origStdin
	})

	// Write a backup file directly so --clear has something to remove.
	backupDir := filepath.Join(stateDir, "mo", "backup")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	port = findFreePort(t)
	backupPath := filepath.Join(backupDir, fmt.Sprintf("mo-%d.json", port))
	if err := os.WriteFile(backupPath, []byte(`{"groups":{}}`), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	clearBackup = true
	foreground = true
	bind = "127.0.0.1"
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("Pipe: %v", err)
	}
	t.Cleanup(func() { r.Close() })
	if _, err := w.WriteString("y\n"); err != nil {
		t.Fatalf("WriteString: %v", err)
	}
	w.Close()
	os.Stdin = r

	out := captureStderr(t, func() {
		if err := run(rootCmd, nil); err != nil {
			t.Fatalf("run --clear: %v", err)
		}
	})

	if !strings.Contains(out, "cleared saved session") {
		t.Fatalf("expected cleared-session message, got %q", out)
	}
	if _, err := os.Stat(backupPath); !os.IsNotExist(err) {
		t.Fatalf("backup file should be removed, stat err: %v", err)
	}
}

func TestRun_ClearCancellation(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateDir)

	prevClear, prevForeground, prevBind, prevPort := clearBackup, foreground, bind, port
	origStdin := os.Stdin
	t.Cleanup(func() {
		clearBackup = prevClear
		foreground = prevForeground
		bind = prevBind
		port = prevPort
		os.Stdin = origStdin
	})

	port = findFreePort(t)
	backupDir := filepath.Join(stateDir, "mo", "backup")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupPath := filepath.Join(backupDir, fmt.Sprintf("mo-%d.json", port))
	if err := os.WriteFile(backupPath, []byte(`{"groups":{}}`), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	clearBackup = true
	foreground = true
	bind = "127.0.0.1"
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("Pipe: %v", err)
	}
	t.Cleanup(func() { r.Close() })
	if _, err := w.WriteString("n\n"); err != nil {
		t.Fatalf("WriteString: %v", err)
	}
	w.Close()
	os.Stdin = r

	out := captureStderr(t, func() {
		if err := run(rootCmd, nil); err != nil {
			t.Fatalf("run: %v", err)
		}
	})
	if !strings.Contains(out, "canceled") {
		t.Fatalf("expected canceled message, got %q", out)
	}
	if _, err := os.Stat(backupPath); err != nil {
		t.Fatalf("backup file should still exist after cancel, got %v", err)
	}
}

func TestRun_DangerouslyAllowRemoteAccessSkipsPrompt(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	// Use a real file so the server can start.
	dir := t.TempDir()
	f := filepath.Join(dir, "a.md")
	if err := os.WriteFile(f, []byte("# A"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	prevForeground := foreground
	foreground = true
	prevBind := bind
	bind = "0.0.0.0"
	prevPort := port
	port = findFreePort(t)
	prevNoOpen := noOpen
	noOpen = true
	prevDangerous := dangerouslyAllowRemoteAccess
	dangerouslyAllowRemoteAccess = true
	defer func() {
		foreground = prevForeground
		bind = prevBind
		port = prevPort
		noOpen = prevNoOpen
		dangerouslyAllowRemoteAccess = prevDangerous
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rootCmd.SetContext(ctx)

	done := make(chan error, 1)
	go func() {
		captureStdout(t, func() {
			captureStderr(t, func() {
				done <- run(rootCmd, []string{f})
			})
		})
	}()

	// Let the server come up, then cancel.
	addr := fmt.Sprintf("0.0.0.0:%d", port)
	if err := waitForServerUp(addr, 4*time.Second); err != nil {
		t.Fatalf("server did not start: %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run returned: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run did not exit after context cancel")
	}
}

func TestJSONServeOutputShape(t *testing.T) {
	// Sanity check the JSON shapes we expose.
	b, err := json.Marshal(jsonServeOutput{URL: "http://x", Files: []jsonFileEntry{{URL: "u", Name: "n", Path: "p"}}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"url":"http://x"`) {
		t.Fatalf("unexpected JSON: %s", string(b))
	}

	b2, err := json.Marshal(jsonStatusEntry{URL: "http://x", Status: "running", PID: 1, Version: "v"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b2), `"status":"running"`) {
		t.Fatalf("unexpected JSON: %s", string(b2))
	}
}
