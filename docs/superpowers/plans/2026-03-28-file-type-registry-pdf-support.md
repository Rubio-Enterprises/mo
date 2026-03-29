# File Type Registry & PDF Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a modular file type rendering system with PDF support, replacing the monolithic MarkdownViewer with a registry-based FileViewer that dispatches to per-type renderers.

**Architecture:** Backend detects file type from extension and exposes it on FileEntry. A new raw endpoint serves binary files with correct Content-Type. The frontend uses a renderer registry mapping file types to React components, with a FileViewer dispatcher handling content fetching, toolbar, and layout. react-pdf (lazy-loaded) renders PDFs.

**Tech Stack:** Go 1.26+, TypeScript, React 19, react-pdf, pdfjs-dist, Vite, vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-03-28-file-type-registry-pdf-support-design.md`

---

## File Structure

### Phase 1: Backend

#### New Files
| File | Responsibility |
|------|---------------|
| `internal/server/filetype.go` | `FileType` named string type, constants, `DetectFileType()` extension mapping |
| `internal/server/filetype_test.go` | Unit tests for type detection |

#### Modified Files
| File | Changes |
|------|---------|
| `internal/server/server.go` | Add `Type` field to `FileEntry`, rework `AddFile` binary check, add `handleFileServe` endpoint, rename `handleFileRaw` → `handleFileAsset`, add content endpoint type guard, update CSP, update route registration |
| `internal/server/server_test.go` | Update binary rejection tests, add type-aware AddFile tests, add handleFileServe tests, add route coexistence tests, add content endpoint guard tests |

### Phase 2: Frontend Extraction

#### New Files
| File | Responsibility |
|------|---------------|
| `internal/frontend/src/renderers/registry.ts` | Renderer registry: type definitions, feature flags, registry map |
| `internal/frontend/src/renderers/registry.test.ts` | Registry completeness tests |
| `internal/frontend/src/renderers/MarkdownRenderer.tsx` | Markdown rendering extracted from MarkdownViewer |
| `internal/frontend/src/renderers/CodeRenderer.tsx` | Code syntax highlighting extracted from MarkdownViewer |
| `internal/frontend/src/renderers/MarkdownRenderer.test.tsx` | Basic rendering tests |
| `internal/frontend/src/renderers/CodeRenderer.test.tsx` | Basic rendering tests |
| `internal/frontend/src/components/FileViewer.tsx` | Dispatcher: content fetching, toolbar, layout, renderer selection |
| `internal/frontend/src/components/FileViewer.test.tsx` | Dispatcher tests |

#### Modified Files
| File | Changes |
|------|---------|
| `internal/frontend/src/hooks/useApi.ts` | Add `type` field to `FileEntry`, add `rawFileUrl()` builder, add `FileType` type export |
| `internal/frontend/src/utils/filetype.ts` | Delete `isMarkdownFile()`, keep `detectLanguage()` |
| `internal/frontend/src/utils/filetype.test.ts` | Remove `isMarkdownFile` tests |
| `internal/frontend/src/components/App.tsx` | Replace `MarkdownViewer` with `FileViewer`, update imports, pass features-aware props |

#### Deleted Files
| File | Reason |
|------|--------|
| `internal/frontend/src/components/MarkdownViewer.tsx` | Replaced by FileViewer + MarkdownRenderer + CodeRenderer |

### Phase 3: PDF Support

#### New Files
| File | Responsibility |
|------|---------------|
| `internal/frontend/src/renderers/PdfRenderer.tsx` | PDF rendering via react-pdf, lazy-loaded |
| `internal/frontend/src/renderers/PdfRenderer.test.tsx` | Mocked react-pdf tests |
| `internal/frontend/src/renderers/GenericRenderer.tsx` | Binary file fallback: metadata + download link |
| `internal/frontend/src/renderers/GenericRenderer.test.tsx` | Generic renderer tests |
| `internal/frontend/src/renderers/ImageRenderer.tsx` | Placeholder image renderer |
| `testdata/sample.pdf` | Test PDF file |

#### Modified Files
| File | Changes |
|------|---------|
| `internal/frontend/package.json` | Add `react-pdf` dependency |
| `internal/frontend/src/renderers/registry.ts` | Wire PdfRenderer, GenericRenderer, ImageRenderer |

---

## Phase 1: Backend

### Task 1: File Type Detection

**Files:**
- Create: `internal/server/filetype.go`
- Create: `internal/server/filetype_test.go`

- [ ] **Step 1: Write failing tests for DetectFileType**

Create `internal/server/filetype_test.go`:

```go
package server

import "testing"

func TestDetectFileType(t *testing.T) {
	tests := []struct {
		path string
		want FileType
	}{
		// Markdown
		{"/docs/README.md", FileTypeMarkdown},
		{"/docs/page.mdx", FileTypeMarkdown},
		{"/docs/notes.markdown", FileTypeMarkdown},
		{"/docs/notes.mdown", FileTypeMarkdown},
		{"/docs/notes.mkdn", FileTypeMarkdown},
		{"/docs/notes.mkd", FileTypeMarkdown},

		// PDF
		{"/files/report.pdf", FileTypePDF},

		// Image
		{"/img/photo.png", FileTypeImage},
		{"/img/photo.jpg", FileTypeImage},
		{"/img/photo.jpeg", FileTypeImage},
		{"/img/photo.gif", FileTypeImage},
		{"/img/photo.webp", FileTypeImage},
		{"/img/icon.ico", FileTypeImage},
		{"/img/icon.bmp", FileTypeImage},

		// Code
		{"/src/main.go", FileTypeCode},
		{"/src/app.ts", FileTypeCode},
		{"/src/style.css", FileTypeCode},
		{"/src/config.json", FileTypeCode},
		{"/src/data.yaml", FileTypeCode},
		{"/src/image.svg", FileTypeCode},
		{"/Dockerfile", FileTypeCode},
		{"/Makefile", FileTypeCode},

		// Unknown
		{"/files/data.xyz", FileTypeUnknown},
		{"/files/noext", FileTypeUnknown},
		{"/.gitignore", FileTypeUnknown},

		// Case insensitivity
		{"/docs/README.MD", FileTypeMarkdown},
		{"/files/report.PDF", FileTypePDF},
		{"/img/photo.PNG", FileTypeImage},
		{"/src/main.Go", FileTypeCode},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := DetectFileType(tt.path)
			if got != tt.want {
				t.Errorf("DetectFileType(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestDetectFileType_NeverReturnsBinary(t *testing.T) {
	// FileTypeBinary is only produced by promotion in AddFile, never by DetectFileType.
	paths := []string{"/a.bin", "/b.exe", "/c.dll", "/d.so", "/e.dat", "/f"}
	for _, p := range paths {
		got := DetectFileType(p)
		if got == FileTypeBinary {
			t.Errorf("DetectFileType(%q) = %q, must never return FileTypeBinary", p, got)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /vm-mo && go test ./internal/server/ -run TestDetectFileType -v`
Expected: FAIL — `FileType` and `DetectFileType` not defined.

- [ ] **Step 3: Implement filetype.go**

Create `internal/server/filetype.go`:

```go
package server

import (
	"path/filepath"
	"strings"
)

// FileType represents the category of a file for rendering purposes.
type FileType string

const (
	FileTypeMarkdown FileType = "markdown"
	FileTypeCode     FileType = "code"
	FileTypePDF      FileType = "pdf"
	FileTypeImage    FileType = "image"
	FileTypeBinary   FileType = "binary"
	FileTypeUnknown  FileType = "unknown"
)

// DetectFileType determines the file type from the file path's extension.
// It never returns FileTypeBinary — that type is only produced by the
// unknown→binary promotion in AddFile when null bytes are detected.
func DetectFileType(path string) FileType {
	base := filepath.Base(path)
	lower := strings.ToLower(base)

	// Check basename-matched types first (Dockerfile, Makefile).
	if lower == "dockerfile" || strings.HasPrefix(lower, "dockerfile.") {
		return FileTypeCode
	}
	if lower == "makefile" || lower == "gnumakefile" {
		return FileTypeCode
	}

	ext := strings.ToLower(filepath.Ext(base))
	if ext == "" {
		return FileTypeUnknown
	}
	ext = ext[1:] // strip leading dot

	if markdownExts[ext] {
		return FileTypeMarkdown
	}
	if ext == "pdf" {
		return FileTypePDF
	}
	if imageExts[ext] {
		return FileTypeImage
	}
	if codeExts[ext] {
		return FileTypeCode
	}
	return FileTypeUnknown
}

var markdownExts = map[string]bool{
	"md": true, "mdx": true, "markdown": true,
	"mdown": true, "mkdn": true, "mkd": true,
}

var imageExts = map[string]bool{
	"png": true, "jpg": true, "jpeg": true, "gif": true,
	"webp": true, "ico": true, "bmp": true,
}

// codeExts mirrors the frontend detectLanguage() map in filetype.ts.
// SVG is classified as code (syntax-highlighted XML), not image.
var codeExts = map[string]bool{
	"ts": true, "tsx": true, "js": true, "jsx": true, "mjs": true, "cjs": true,
	"css": true, "scss": true, "less": true, "sass": true,
	"html": true, "htm": true, "xml": true, "svg": true, "xsl": true,
	"json": true, "jsonc": true, "json5": true,
	"yaml": true, "yml": true, "toml": true, "ini": true,
	"go": true, "rs": true, "py": true, "rb": true, "java": true, "kt": true,
	"c": true, "cpp": true, "cc": true, "cxx": true, "h": true, "hpp": true,
	"cs": true, "swift": true, "m": true,
	"sh": true, "bash": true, "zsh": true, "fish": true, "ps1": true, "bat": true, "cmd": true,
	"sql": true, "graphql": true, "gql": true,
	"r": true, "lua": true, "perl": true, "pl": true, "php": true,
	"ex": true, "exs": true, "erl": true, "hs": true, "clj": true, "scala": true,
	"dart": true, "zig": true, "nim": true, "v": true,
	"tf": true, "hcl": true, "proto": true,
	"diff": true, "patch": true, "log": true,
	"vue": true, "svelte": true, "astro": true,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /vm-mo && go test ./internal/server/ -run TestDetectFileType -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /vm-mo && git add internal/server/filetype.go internal/server/filetype_test.go && git commit -m "feat: add file type detection with extension mapping"
```

---

### Task 2: Add Type Field to FileEntry and Rework AddFile

**Files:**
- Modify: `internal/server/server.go:28-35` (FileEntry struct)
- Modify: `internal/server/server.go:249-308` (AddFile method)
- Modify: `internal/server/server_test.go:1117-1151` (TestAddFile_RejectsBinaryFile)
- Modify: `internal/server/server_test.go:1216-1270` (TestHandleAddFile_RejectsBinaryFile)

- [ ] **Step 1: Write failing tests for type-aware AddFile**

Add to `internal/server/server_test.go`:

```go
func TestAddFile_SetsFileType(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()

	tests := []struct {
		name     string
		filename string
		content  []byte
		wantType FileType
		wantErr  bool
	}{
		{"markdown", "readme.md", []byte("# Hello"), FileTypeMarkdown, false},
		{"code", "main.go", []byte("package main"), FileTypeCode, false},
		{"pdf", "doc.pdf", []byte("%PDF-1.4\x00binary"), FileTypePDF, false},
		{"image", "photo.png", []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00}, FileTypeImage, false},
		{"unknown text", "data.xyz", []byte("some text"), FileTypeUnknown, false},
		{"unknown binary promoted", "data.bin", []byte("has\x00null"), FileTypeBinary, false},
		{"markdown with null bytes", "bad.md", []byte("# Hi\x00"), FileTypeMarkdown, true},
		{"code with null bytes", "bad.go", []byte("package\x00main"), FileTypeCode, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(dir, tt.filename)
			os.WriteFile(path, tt.content, 0o600) //nolint:errcheck

			entry, err := s.AddFile(path, DefaultGroup)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if entry.Type != tt.wantType {
				t.Errorf("Type = %q, want %q", entry.Type, tt.wantType)
			}

			// Clean up for next test.
			s.RemoveFile(entry.ID)
		})
	}
}

func TestAddFile_RejectsDirectoryWithPDFExtension(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()
	pdfDir := filepath.Join(dir, "something.pdf")
	os.Mkdir(pdfDir, 0o755) //nolint:errcheck

	_, err := s.AddFile(pdfDir, DefaultGroup)
	if err == nil {
		t.Fatal("expected error for directory with .pdf extension")
	}
}

func TestAddFile_TitleExtractionByType(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()

	// Markdown gets title.
	mdPath := filepath.Join(dir, "doc.md")
	os.WriteFile(mdPath, []byte("# My Title"), 0o600) //nolint:errcheck
	entry, err := s.AddFile(mdPath, DefaultGroup)
	if err != nil {
		t.Fatal(err)
	}
	if entry.Title != "My Title" {
		t.Errorf("markdown Title = %q, want %q", entry.Title, "My Title")
	}

	// Code with # comment also gets title (preserves existing behavior).
	goPath := filepath.Join(dir, "script.sh")
	os.WriteFile(goPath, []byte("# Setup Script"), 0o600) //nolint:errcheck
	entry2, err := s.AddFile(goPath, DefaultGroup)
	if err != nil {
		t.Fatal(err)
	}
	if entry2.Title != "Setup Script" {
		t.Errorf("code Title = %q, want %q", entry2.Title, "Setup Script")
	}

	// PDF skips title extraction.
	pdfPath := filepath.Join(dir, "doc.pdf")
	os.WriteFile(pdfPath, []byte("%PDF-1.4\x00binary"), 0o600) //nolint:errcheck
	entry3, err := s.AddFile(pdfPath, DefaultGroup)
	if err != nil {
		t.Fatal(err)
	}
	if entry3.Title != "" {
		t.Errorf("pdf Title = %q, want empty", entry3.Title)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /vm-mo && go test ./internal/server/ -run "TestAddFile_SetsFileType|TestAddFile_RejectsDirectory|TestAddFile_TitleExtraction" -v`
Expected: FAIL — `FileEntry` has no `Type` field.

- [ ] **Step 3: Update FileEntry struct**

In `internal/server/server.go`, replace the FileEntry struct (lines 28-35):

```go
type FileEntry struct {
	Name     string   `json:"name"`
	ID       string   `json:"id"`
	Path     string   `json:"path"`
	Title    string   `json:"title,omitempty"`
	Uploaded bool     `json:"uploaded,omitempty"`
	Type     FileType `json:"type"`
	content  string
}
```

- [ ] **Step 4: Rework AddFile method**

In `internal/server/server.go`, replace the AddFile method body (lines 249-308). The new version:

```go
func (s *State) AddFile(absPath, groupName string) (*FileEntry, error) {
	// Check for duplicates before doing any I/O.
	s.mu.RLock()
	if g, ok := s.groups[groupName]; ok {
		for _, f := range g.Files {
			if f.Path == absPath {
				s.mu.RUnlock()
				return f, nil
			}
		}
	}
	s.mu.RUnlock()

	fileType := DetectFileType(absPath)

	var head []byte
	var title string

	switch fileType {
	case FileTypePDF, FileTypeImage:
		// Binary types: verify regular file, skip content checks.
		fi, err := os.Stat(absPath)
		if err != nil {
			if os.IsNotExist(err) {
				// Allow non-existent files (existing behavior).
				break
			}
			return nil, fmt.Errorf("failed to stat file %s: %w", absPath, err)
		}
		if !fi.Mode().IsRegular() {
			return nil, fmt.Errorf("not a regular file: %s", absPath)
		}
	default:
		// Text types: read head for binary check and title extraction.
		var err error
		head, err = readFileHead(absPath)
		if err != nil {
			if !os.IsNotExist(err) {
				return nil, fmt.Errorf("failed to read file %s: %w", absPath, err)
			}
		} else if len(head) > 0 && bytes.IndexByte(head, 0) >= 0 {
			if fileType == FileTypeUnknown {
				fileType = FileTypeBinary
			} else {
				return nil, fmt.Errorf("%s: %w", absPath, ErrBinaryFile)
			}
		}

		if fileType != FileTypeBinary {
			title = extractTitle(string(head))
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	g, ok := s.groups[groupName]
	if !ok {
		g = &Group{Name: groupName}
		s.groups[groupName] = g
	}

	// Re-check after re-acquiring the lock.
	for _, f := range g.Files {
		if f.Path == absPath {
			return f, nil
		}
	}

	entry := &FileEntry{
		Name:  filepath.Base(absPath),
		ID:    FileID(absPath),
		Path:  absPath,
		Title: title,
		Type:  fileType,
	}
	g.Files = append(g.Files, entry)

	if s.watcher != nil {
		if err := s.watcher.Add(absPath); err != nil {
			slog.Warn("failed to watch file", "path", absPath, "error", err)
		}
	}

	slog.Info("file added", "path", absPath, "group", groupName, "id", entry.ID)

	s.sendEvent(sseEvent{Name: eventUpdate, Data: "{}"})
	return entry, nil
}
```

- [ ] **Step 5: Update existing binary rejection tests**

In `internal/server/server_test.go`, replace `TestAddFile_RejectsBinaryFile` (lines 1117-1151):

```go
func TestAddFile_RejectsBinaryFile(t *testing.T) {
	s := newTestState(t)
	dir := t.TempDir()

	// Binary file with known code extension is still rejected.
	binFile := filepath.Join(dir, "bad.go")
	os.WriteFile(binFile, []byte("package\x00main"), 0o600) //nolint:errcheck

	_, err := s.AddFile(binFile, DefaultGroup)
	if err == nil {
		t.Fatal("expected error for binary code file, got nil")
	}
	if !errors.Is(err, ErrBinaryFile) {
		t.Fatalf("expected ErrBinaryFile, got: %v", err)
	}

	// Binary file with unknown extension is accepted as FileTypeBinary.
	unknownBin := filepath.Join(dir, "data.bin")
	os.WriteFile(unknownBin, []byte("has\x00null"), 0o600) //nolint:errcheck

	entry, err := s.AddFile(unknownBin, DefaultGroup)
	if err != nil {
		t.Fatalf("unexpected error for unknown binary: %v", err)
	}
	if entry.Type != FileTypeBinary {
		t.Errorf("Type = %q, want %q", entry.Type, FileTypeBinary)
	}

	// Text file should succeed.
	txtFile := filepath.Join(dir, "readme.md")
	os.WriteFile(txtFile, []byte("# Hello"), 0o600) //nolint:errcheck

	entry, err = s.AddFile(txtFile, DefaultGroup)
	if err != nil {
		t.Fatalf("unexpected error for text file: %v", err)
	}
	if entry == nil {
		t.Fatal("expected non-nil entry for text file")
	}

	// Non-existent file should not error.
	_, err = s.AddFile(filepath.Join(dir, "nonexistent.md"), DefaultGroup)
	if err != nil {
		t.Fatalf("unexpected error for non-existent file: %v", err)
	}
}
```

Update the binary subtest of `TestHandleAddFile_RejectsBinaryFile` (lines 1216-1270). The "returns 400 for binary file" subtest should use a known code extension (so it's still rejected), and add a new subtest for accepted binary files:

```go
func TestHandleAddFile_RejectsBinaryFile(t *testing.T) {
	dir := t.TempDir()

	t.Run("returns 400 for binary code file", func(t *testing.T) {
		s := newTestState(t)
		handler := NewHandler(s)

		binFile := filepath.Join(dir, "bad.go")
		os.WriteFile(binFile, []byte("package\x00main"), 0o600) //nolint:errcheck

		body, err := json.Marshal(addFileRequest{Path: binFile, Group: DefaultGroup})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", "/_/api/files", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("got status %d, want %d", rec.Code, http.StatusBadRequest)
		}
	})

	t.Run("returns 200 for unknown binary file", func(t *testing.T) {
		s := newTestState(t)
		handler := NewHandler(s)

		binFile := filepath.Join(dir, "data.bin")
		os.WriteFile(binFile, []byte("has\x00null"), 0o600) //nolint:errcheck

		body, err := json.Marshal(addFileRequest{Path: binFile, Group: DefaultGroup})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", "/_/api/files", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want %d", rec.Code, http.StatusOK)
		}

		var entry FileEntry
		if err := json.NewDecoder(rec.Body).Decode(&entry); err != nil {
			t.Fatal(err)
		}
		if entry.Type != FileTypeBinary {
			t.Errorf("Type = %q, want %q", entry.Type, FileTypeBinary)
		}
	})

	t.Run("returns 200 for text file", func(t *testing.T) {
		s := newTestState(t)
		handler := NewHandler(s)

		txtFile := filepath.Join(dir, "readme.md")
		os.WriteFile(txtFile, []byte("# Hello"), 0o600) //nolint:errcheck

		body, err := json.Marshal(addFileRequest{Path: txtFile, Group: DefaultGroup})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", "/_/api/files", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want %d", rec.Code, http.StatusOK)
		}

		var entry FileEntry
		if err := json.NewDecoder(rec.Body).Decode(&entry); err != nil {
			t.Fatal(err)
		}
		if entry.Name != "readme.md" {
			t.Fatalf("got name %q, want %q", entry.Name, "readme.md")
		}
	})
}
```

- [ ] **Step 6: Run all tests**

Run: `cd /vm-mo && go test ./internal/server/ -v`
Expected: PASS — all existing tests and new tests pass.

- [ ] **Step 7: Commit**

```bash
cd /vm-mo && git add internal/server/server.go internal/server/server_test.go && git commit -m "feat: add Type field to FileEntry with type-aware binary check"
```

---

### Task 3: Add handleFileServe Endpoint and Rename handleFileRaw

**Files:**
- Modify: `internal/server/server.go:1200-1222` (route registration)
- Modify: `internal/server/server.go:1226-1236` (CSP header)
- Modify: `internal/server/server.go:1388-1424` (handleFileContent — add type guard)
- Modify: `internal/server/server.go:1426-1458` (rename handleFileRaw → handleFileAsset)
- Modify: `internal/server/server_test.go`

- [ ] **Step 1: Write failing tests for handleFileServe**

Add to `internal/server/server_test.go`:

```go
func TestHandleFileServe(t *testing.T) {
	dir := t.TempDir()

	t.Run("serves PDF with correct content type", func(t *testing.T) {
		s := newTestState(t)
		handler := NewHandler(s)

		pdfFile := filepath.Join(dir, "doc.pdf")
		os.WriteFile(pdfFile, []byte("%PDF-1.4\x00test content"), 0o600) //nolint:errcheck

		entry, err := s.AddFile(pdfFile, DefaultGroup)
		if err != nil {
			t.Fatal(err)
		}

		req := httptest.NewRequest("GET", "/_/api/files/"+entry.ID+"/raw", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want %d", rec.Code, http.StatusOK)
		}
		ct := rec.Header().Get("Content-Type")
		if !strings.Contains(ct, "application/pdf") {
			t.Errorf("Content-Type = %q, want application/pdf", ct)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Error("missing X-Content-Type-Options: nosniff header")
		}
	})

	t.Run("returns 404 for unknown ID", func(t *testing.T) {
		s := newTestState(t)
		handler := NewHandler(s)

		req := httptest.NewRequest("GET", "/_/api/files/nonexistent/raw", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("got status %d, want %d", rec.Code, http.StatusNotFound)
		}
	})

	t.Run("returns 404 for uploaded file", func(t *testing.T) {
		s := newTestState(t)
		handler := NewHandler(s)

		s.AddUploadedFile("test.md", "# Hello", DefaultGroup) //nolint:errcheck

		entry := s.Groups()[0].Files[0]
		req := httptest.NewRequest("GET", "/_/api/files/"+entry.ID+"/raw", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("got status %d, want %d", rec.Code, http.StatusNotFound)
		}
	})

	t.Run("cache busting param does not affect response", func(t *testing.T) {
		s := newTestState(t)
		handler := NewHandler(s)

		txtFile := filepath.Join(dir, "hello.md")
		os.WriteFile(txtFile, []byte("# Hello"), 0o600) //nolint:errcheck

		entry, err := s.AddFile(txtFile, DefaultGroup)
		if err != nil {
			t.Fatal(err)
		}

		req := httptest.NewRequest("GET", "/_/api/files/"+entry.ID+"/raw?v=42", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want %d", rec.Code, http.StatusOK)
		}
		if !strings.Contains(rec.Body.String(), "# Hello") {
			t.Error("response body does not contain file content")
		}
	})
}

func TestHandleFileServe_RouteCoexistence(t *testing.T) {
	dir := t.TempDir()
	s := newTestState(t)
	handler := NewHandler(s)

	mdFile := filepath.Join(dir, "readme.md")
	os.WriteFile(mdFile, []byte("# Hello"), 0o600) //nolint:errcheck

	// Create a sibling image file.
	imgFile := filepath.Join(dir, "image.png")
	os.WriteFile(imgFile, []byte("fakepng"), 0o600) //nolint:errcheck

	entry, err := s.AddFile(mdFile, DefaultGroup)
	if err != nil {
		t.Fatal(err)
	}

	// /raw → handleFileServe (serves the file itself).
	req := httptest.NewRequest("GET", "/_/api/files/"+entry.ID+"/raw", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/raw: got status %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(rec.Body.String(), "# Hello") {
		t.Error("/raw: expected file content")
	}

	// /raw/image.png → handleFileAsset (serves sibling asset).
	req = httptest.NewRequest("GET", "/_/api/files/"+entry.ID+"/raw/image.png", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/raw/image.png: got status %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(rec.Body.String(), "fakepng") {
		t.Error("/raw/image.png: expected sibling asset content")
	}
}

func TestHandleFileContent_RejectsBinaryTypes(t *testing.T) {
	dir := t.TempDir()
	s := newTestState(t)
	handler := NewHandler(s)

	pdfFile := filepath.Join(dir, "doc.pdf")
	os.WriteFile(pdfFile, []byte("%PDF-1.4\x00binary"), 0o600) //nolint:errcheck

	entry, err := s.AddFile(pdfFile, DefaultGroup)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/_/api/files/"+entry.ID+"/content", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("got status %d, want %d", rec.Code, http.StatusUnsupportedMediaType)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /vm-mo && go test ./internal/server/ -run "TestHandleFileServe|TestHandleFileContent_Rejects" -v`
Expected: FAIL — `handleFileServe` not defined, routes not registered.

- [ ] **Step 3: Add handleFileServe function**

Add to `internal/server/server.go` after the existing `handleFileRaw` function:

```go
func handleFileServe(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}

		entry := state.FindFile(id)
		if entry == nil {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}

		if entry.Uploaded {
			http.Error(w, "raw serving not available for uploaded files", http.StatusNotFound)
			return
		}

		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, entry.Path)
	}
}
```

- [ ] **Step 4: Rename handleFileRaw → handleFileAsset**

In `internal/server/server.go`, rename the function at line 1426:

Change `func handleFileRaw(state *State) http.HandlerFunc {` to `func handleFileAsset(state *State) http.HandlerFunc {`

Add empty path guard at the start of the handler body (after the `entry.Uploaded` check):

```go
		relPath := r.PathValue("path")
		if relPath == "" {
			http.Error(w, "missing asset path", http.StatusBadRequest)
			return
		}
```

- [ ] **Step 5: Add type guard to handleFileContent**

In `internal/server/server.go`, add after the `entry == nil` check in `handleFileContent` (around line 1400):

```go
		// Reject binary file types — their content cannot be JSON-serialized.
		switch entry.Type {
		case FileTypePDF, FileTypeImage, FileTypeBinary:
			http.Error(w, "content endpoint not supported for binary file types; use the raw endpoint", http.StatusUnsupportedMediaType)
			return
		}
```

- [ ] **Step 6: Update route registration**

In `internal/server/server.go` `NewHandler` function (around line 1208-1210), update:

```go
	mux.HandleFunc("GET /_/api/files/{id}/content", handleFileContent(state))
	mux.HandleFunc("GET /_/api/files/{id}/raw", handleFileServe(state))
	mux.HandleFunc("GET /_/api/files/{id}/raw/{path...}", handleFileAsset(state))
```

- [ ] **Step 7: Update CSP header**

In `internal/server/server.go` `withCSP` function (around line 1226), add `worker-src 'self' blob:` to the CSP string. Update the connect-src line:

```go
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; "+
			"script-src 'self' 'unsafe-eval'; "+
			"style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' https: data:; "+
			"font-src 'self' data:; "+
			"connect-src 'self'; "+
			"worker-src 'self' blob:; "+
			"object-src 'none'; "+
			"base-uri 'self'; "+
			"form-action 'self'; "+
			"frame-ancestors 'none'")
```

- [ ] **Step 8: Run all tests**

Run: `cd /vm-mo && go test ./internal/server/ -v`
Expected: PASS

- [ ] **Step 9: Run linter**

Run: `cd /vm-mo && make lint`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
cd /vm-mo && git add internal/server/server.go internal/server/server_test.go && git commit -m "feat: add raw file serving endpoint, rename handleFileRaw, update CSP"
```

---

## Phase 2: Frontend Extraction

### Task 4: Update Frontend FileEntry and API Layer

**Files:**
- Modify: `internal/frontend/src/hooks/useApi.ts:1-7`
- Modify: `internal/frontend/src/utils/filetype.ts`
- Modify: `internal/frontend/src/utils/filetype.test.ts`

- [ ] **Step 1: Add FileType and update FileEntry interface**

In `internal/frontend/src/hooks/useApi.ts`, replace the `FileEntry` interface (lines 1-7):

```typescript
export type FileType =
  | "markdown"
  | "code"
  | "pdf"
  | "image"
  | "binary"
  | "unknown";

export interface FileEntry {
  name: string;
  id: string;
  path: string;
  title?: string;
  uploaded?: boolean;
  type: FileType;
}
```

Add the `rawFileUrl` builder at the end of the file:

```typescript
export function rawFileUrl(id: string, revision?: number): string {
  const base = `/_/api/files/${id}/raw`;
  return revision != null ? `${base}?v=${revision}` : base;
}
```

- [ ] **Step 2: Remove isMarkdownFile from filetype.ts**

In `internal/frontend/src/utils/filetype.ts`, delete the `markdownExtensions` Set and the `isMarkdownFile` function (lines 1-8). Keep only `detectLanguage` and its supporting `extToLang` map.

- [ ] **Step 3: Update filetype.test.ts**

In `internal/frontend/src/utils/filetype.test.ts`, remove all `isMarkdownFile` test cases. Keep the `detectLanguage` tests unchanged.

- [ ] **Step 4: Update App.tsx import**

In `internal/frontend/src/components/App.tsx`, find and remove the `isMarkdownFile` import (line 22):

```typescript
// Remove this line:
import { isMarkdownFile } from "../utils/filetype";
```

Update the `useEffect` that auto-closes ToC for non-markdown files (lines 192-196). Replace the `isMarkdownFile` check with a type check:

```typescript
useEffect(() => {
  if (activeFile && activeFile.type !== "markdown") {
    setTocOpen(false);
  }
}, [activeFile]);
```

This requires access to the active file's type. The simplest approach: derive `activeFile` from groups and activeFileId (it's already available as `activeFileName` is derived at line 174-178 — extend that pattern to get the full file object).

- [ ] **Step 5: Run frontend tests**

Run: `cd /vm-mo/internal/frontend && pnpm test`
Expected: Tests pass (filetype tests updated, no isMarkdownFile references remain).

- [ ] **Step 6: Commit**

```bash
cd /vm-mo && git add internal/frontend/src/hooks/useApi.ts internal/frontend/src/utils/filetype.ts internal/frontend/src/utils/filetype.test.ts internal/frontend/src/components/App.tsx && git commit -m "feat: add FileType to frontend, add rawFileUrl, remove isMarkdownFile"
```

---

### Task 5: Create Renderer Registry

**Files:**
- Create: `internal/frontend/src/renderers/registry.ts`
- Create: `internal/frontend/src/renderers/registry.test.ts`

- [ ] **Step 1: Write registry test**

Create `internal/frontend/src/renderers/registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { rendererRegistry } from "./registry";
import type { FileType } from "../hooks/useApi";

const allTypes: FileType[] = [
  "markdown",
  "code",
  "pdf",
  "image",
  "binary",
  "unknown",
];

describe("rendererRegistry", () => {
  it("has an entry for every FileType", () => {
    for (const type of allTypes) {
      expect(rendererRegistry[type]).toBeDefined();
    }
  });

  it("every entry has valid contentSource", () => {
    for (const [type, entry] of Object.entries(rendererRegistry)) {
      expect(["text", "raw"]).toContain(entry.contentSource);
    }
  });

  it("every entry has boolean feature flags", () => {
    for (const [type, entry] of Object.entries(rendererRegistry)) {
      expect(typeof entry.features.toc).toBe("boolean");
      expect(typeof entry.features.raw).toBe("boolean");
      expect(typeof entry.features.headings).toBe("boolean");
      expect(typeof entry.features.copyable).toBe("boolean");
    }
  });

  it("markdown has toc, raw, headings, copyable enabled", () => {
    const md = rendererRegistry["markdown"];
    expect(md.features).toEqual({
      toc: true,
      raw: true,
      headings: true,
      copyable: true,
    });
    expect(md.contentSource).toBe("text");
  });

  it("pdf has all features disabled", () => {
    const pdf = rendererRegistry["pdf"];
    expect(pdf.features).toEqual({
      toc: false,
      raw: false,
      headings: false,
      copyable: false,
    });
    expect(pdf.contentSource).toBe("raw");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /vm-mo/internal/frontend && pnpm test src/renderers/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create registry.ts**

Create `internal/frontend/src/renderers/registry.ts`:

```typescript
import type { ComponentType } from "react";
import type { FileType } from "../hooks/useApi";

export interface TocHeading {
  id: string;
  text: string;
  level: number;
}

export interface RendererFeatures {
  toc: boolean;
  raw: boolean;
  headings: boolean;
  copyable: boolean;
}

interface BaseRendererProps {
  fileId: string;
  fileName: string;
  revision: number;
  isRawView: boolean;
  onFileOpened?: (fileId: string) => void;
  onHeadingsChange: (headings: TocHeading[]) => void;
  onContentRendered?: () => void;
}

export type TextRendererProps = BaseRendererProps & {
  contentSource: "text";
  content: string;
};

export type RawRendererProps = BaseRendererProps & {
  contentSource: "raw";
  rawUrl: string;
};

export type RendererProps = TextRendererProps | RawRendererProps;

export interface RendererEntry {
  component: ComponentType<RendererProps>;
  features: RendererFeatures;
  contentSource: "text" | "raw";
}

// Placeholder components — replaced in subsequent tasks.
// Using inline stubs so the registry compiles before real renderers exist.
function Placeholder() {
  return null;
}

export const rendererRegistry: Record<FileType, RendererEntry> = {
  markdown: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: true, raw: true, headings: true, copyable: true },
    contentSource: "text",
  },
  code: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
  pdf: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  image: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  binary: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  unknown: {
    component: Placeholder as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /vm-mo/internal/frontend && pnpm test src/renderers/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /vm-mo && git add internal/frontend/src/renderers/ && git commit -m "feat: add renderer registry with type definitions and placeholder components"
```

---

### Task 6: Extract MarkdownRenderer

**Files:**
- Create: `internal/frontend/src/renderers/MarkdownRenderer.tsx`
- Modify: `internal/frontend/src/renderers/registry.ts`

- [ ] **Step 1: Create MarkdownRenderer.tsx**

Extract the markdown-specific rendering logic from `MarkdownViewer.tsx` into `internal/frontend/src/renderers/MarkdownRenderer.tsx`. This includes:

- From `MarkdownViewer.tsx` lines 56-57: `mermaidCounter` and `mermaidQueue` module-level state
- From lines 59-91: `renderMermaid()` function
- From lines 93-189: `MermaidBlock` and `MermaidImageCopyButton` components
- From lines 191-255: `svgToPngBlob` utility
- From lines 261-340: `CodeBlockCopyButton` and `CodeBlock` components
- From lines 342-353: `FrontmatterBlock` component
- From lines 355-387: `HighlightedView` component
- From lines 389-391: `RawView` component
- From lines 393-546: The component body including `useMemo` for `components` object, frontmatter parsing, MDX stripping
- From lines 586-606: Heading extraction logic
- From lines 608-622: Hash scroll and onContentRendered effects

The component receives `TextRendererProps` and renders markdown content. It uses the `content` field from props (content fetching is handled by FileViewer).

```typescript
import type { TextRendererProps } from "./registry";
```

The component must:
1. Accept `TextRendererProps` (narrowing on `contentSource: "text"`)
2. Parse frontmatter from `content`
3. Render via `react-markdown` with all existing rehype/remark plugins
4. Extract headings and call `onHeadingsChange`
5. Handle `isRawView` by rendering `RawView` instead
6. Handle hash scrolling via `pendingHashRef`
7. Call `onContentRendered` after render

Keep the exact same rendering logic — this is a move, not a rewrite. All imports (`react-markdown`, rehype plugins, `shiki`, `mermaid`, etc.) move to this file.

- [ ] **Step 2: Update registry to use MarkdownRenderer**

In `internal/frontend/src/renderers/registry.ts`, replace the markdown placeholder:

```typescript
import { MarkdownRenderer } from "./MarkdownRenderer";

// In the registry:
  markdown: {
    component: MarkdownRenderer as ComponentType<RendererProps>,
    features: { toc: true, raw: true, headings: true, copyable: true },
    contentSource: "text",
  },
```

- [ ] **Step 3: Run frontend tests**

Run: `cd /vm-mo/internal/frontend && pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /vm-mo && git add internal/frontend/src/renderers/ && git commit -m "refactor: extract MarkdownRenderer from MarkdownViewer"
```

---

### Task 7: Extract CodeRenderer

**Files:**
- Create: `internal/frontend/src/renderers/CodeRenderer.tsx`
- Modify: `internal/frontend/src/renderers/registry.ts`

- [ ] **Step 1: Create CodeRenderer.tsx**

Create `internal/frontend/src/renderers/CodeRenderer.tsx`. This component wraps the `HighlightedView` logic for non-markdown code files:

```typescript
import { useEffect, useMemo } from "react";
import { codeToHtml } from "shiki";
import { useState } from "react";
import { detectLanguage } from "../utils/filetype";
import type { TextRendererProps, TocHeading } from "./registry";

export function CodeRenderer(props: TextRendererProps) {
  const { content, fileName, onHeadingsChange, onContentRendered } = props;
  const language = useMemo(() => detectLanguage(fileName), [fileName]);
  const [html, setHtml] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    codeToHtml(content, {
      lang: language,
      theme: "github-dark",
    })
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [content, language]);

  // Code files have no headings.
  useEffect(() => {
    onHeadingsChange([]);
  }, [onHeadingsChange]);

  useEffect(() => {
    onContentRendered?.();
  }, [html, onContentRendered]);

  if (html) {
    return (
      <div
        className="[&_pre]:!rounded-none [&_pre]:!m-0"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="p-4 overflow-x-auto">
      <code>{content}</code>
    </pre>
  );
}
```

- [ ] **Step 2: Update registry**

In `internal/frontend/src/renderers/registry.ts`:

```typescript
import { CodeRenderer } from "./CodeRenderer";

// Update both code and unknown entries:
  code: {
    component: CodeRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
  // ...
  unknown: {
    component: CodeRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
```

- [ ] **Step 3: Run frontend tests**

Run: `cd /vm-mo/internal/frontend && pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /vm-mo && git add internal/frontend/src/renderers/ && git commit -m "refactor: extract CodeRenderer from MarkdownViewer"
```

---

### Task 8: Create FileViewer Dispatcher

**Files:**
- Create: `internal/frontend/src/components/FileViewer.tsx`
- Modify: `internal/frontend/src/components/App.tsx`
- Delete: `internal/frontend/src/components/MarkdownViewer.tsx`

- [ ] **Step 1: Create FileViewer.tsx**

Create `internal/frontend/src/components/FileViewer.tsx`:

```typescript
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { fetchFileContent, rawFileUrl } from "../hooks/useApi";
import type { FileType } from "../hooks/useApi";
import { rendererRegistry } from "../renderers/registry";
import type { TocHeading, RendererProps } from "../renderers/registry";
import { TocToggle } from "./TocToggle";
import { RawToggle } from "./RawToggle";
import { CopyButton } from "./CopyButton";
import { CloseFileButton } from "./CloseFileButton";

interface FileViewerProps {
  fileId: string;
  fileName: string;
  fileType: FileType;
  revision: number;
  onFileOpened: (fileId: string) => void;
  onHeadingsChange: (headings: TocHeading[]) => void;
  onContentRendered?: () => void;
  isTocOpen: boolean;
  onTocToggle: () => void;
  onRemoveFile: () => void;
  isWide: boolean;
}

export function FileViewer({
  fileId,
  fileName,
  fileType,
  revision,
  onFileOpened,
  onHeadingsChange,
  onContentRendered,
  isTocOpen,
  onTocToggle,
  onRemoveFile,
  isWide,
}: FileViewerProps) {
  const entry = rendererRegistry[fileType] ?? rendererRegistry["unknown"];
  const { features, contentSource } = entry;
  const Component = entry.component;

  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [isRawView, setIsRawView] = useState(false);

  // Fetch text content for text-based renderers.
  useEffect(() => {
    if (contentSource !== "text") {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchFileContent(fileId)
      .then((data) => {
        if (!cancelled) {
          setContent(data.content);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent("Failed to load file.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, revision, contentSource]);

  // Clear headings for non-heading file types.
  useEffect(() => {
    if (!features.headings) {
      onHeadingsChange([]);
    }
  }, [features.headings, onHeadingsChange]);

  // Reset raw view when switching files.
  useEffect(() => {
    setIsRawView(false);
  }, [fileId]);

  if (loading && contentSource === "text") {
    return (
      <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
        Loading...
      </div>
    );
  }

  // Build renderer props based on content source.
  const baseProps = {
    fileId,
    fileName,
    revision,
    isRawView,
    onFileOpened,
    onHeadingsChange,
    onContentRendered,
  };

  const rendererProps: RendererProps =
    contentSource === "text"
      ? { ...baseProps, contentSource: "text" as const, content }
      : {
          ...baseProps,
          contentSource: "raw" as const,
          rawUrl: rawFileUrl(fileId, revision),
        };

  return (
    <div className="flex gap-4 px-8 py-4 w-full">
      <article
        className={`markdown-body min-w-0 flex-1${isWide ? " markdown-body--wide" : ""}`}
      >
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
              Loading...
            </div>
          }
        >
          <Component {...rendererProps} />
        </Suspense>
      </article>
      <div className="shrink-0 flex flex-col gap-2 -mr-4 -mt-4">
        {features.toc && (
          <TocToggle isTocOpen={isTocOpen} onToggle={onTocToggle} />
        )}
        {features.raw && (
          <RawToggle
            isRaw={isRawView}
            onToggle={() => setIsRawView((v) => !v)}
          />
        )}
        {features.copyable && <CopyButton content={content} />}
        <CloseFileButton onClose={onRemoveFile} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update App.tsx to use FileViewer**

In `internal/frontend/src/components/App.tsx`:

Replace the `MarkdownViewer` import with `FileViewer`:

```typescript
import { FileViewer } from "./FileViewer";
```

Update the rendering section (around lines 426-437). Replace `<MarkdownViewer ... />` with:

```typescript
{activeFileId != null && activeFile != null ? (
  <FileViewer
    fileId={activeFileId}
    fileName={activeFileName}
    fileType={activeFile.type}
    revision={contentRevision}
    onFileOpened={handleFileOpened}
    onHeadingsChange={setHeadings}
    onContentRendered={wrappedOnContentRendered}
    isTocOpen={tocOpen}
    onTocToggle={() => setTocOpen((v) => !v)}
    onRemoveFile={handleRemoveFile}
    isWide={isWide}
  />
) : (
  <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
    No file selected
  </div>
)}
```

Where `activeFile` is derived from the groups state (find the file entry matching `activeFileId`). Add this derivation near the existing `activeFileName` computation:

```typescript
const activeFile = useMemo(() => {
  if (!activeFileId) return null;
  for (const g of groups) {
    for (const f of g.files) {
      if (f.id === activeFileId) return f;
    }
  }
  return null;
}, [groups, activeFileId]);

const activeFileName = activeFile?.name ?? "";
```

Remove the old `isMarkdownFile` import and the auto-close ToC `useEffect` that used it. The heading clearing is now handled by `FileViewer`.

- [ ] **Step 3: Delete MarkdownViewer.tsx**

Delete `internal/frontend/src/components/MarkdownViewer.tsx`. All its logic now lives in `FileViewer.tsx`, `MarkdownRenderer.tsx`, and `CodeRenderer.tsx`.

- [ ] **Step 4: Run all frontend tests**

Run: `cd /vm-mo/internal/frontend && pnpm test`
Expected: PASS

- [ ] **Step 5: Run full build**

Run: `cd /vm-mo && make build`
Expected: PASS — frontend builds, Go binary compiles.

- [ ] **Step 6: Manual visual regression test**

Run: `cd /vm-mo && make dev ARGS="testdata/basic.md"`

Verify:
- Markdown file renders correctly with all formatting
- ToC toggle works and shows headings
- Raw view toggle works
- Theme toggle works
- Width toggle works
- Sidebar resize works
- Open a code file (if available) and verify syntax highlighting

- [ ] **Step 7: Commit**

```bash
cd /vm-mo && git add -A && git commit -m "refactor: replace MarkdownViewer with FileViewer dispatcher and renderer registry"
```

---

### Task 9: Add FileViewer Tests

**Files:**
- Create: `internal/frontend/src/components/FileViewer.test.tsx`

- [ ] **Step 1: Write FileViewer tests**

Create `internal/frontend/src/components/FileViewer.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FileViewer } from "./FileViewer";

// Mock the API module.
vi.mock("../hooks/useApi", async () => {
  const actual = await vi.importActual("../hooks/useApi");
  return {
    ...actual,
    fetchFileContent: vi.fn().mockResolvedValue({
      content: "# Test Content",
      baseDir: "/test",
    }),
  };
});

// Mock the renderers to simple stubs.
vi.mock("../renderers/registry", () => {
  function StubRenderer(props: { contentSource: string; content?: string; rawUrl?: string }) {
    if (props.contentSource === "text") {
      return <div data-testid="text-renderer">{props.content}</div>;
    }
    return <div data-testid="raw-renderer">{props.rawUrl}</div>;
  }

  return {
    rendererRegistry: {
      markdown: {
        component: StubRenderer,
        features: { toc: true, raw: true, headings: true, copyable: true },
        contentSource: "text",
      },
      code: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: true },
        contentSource: "text",
      },
      pdf: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: false },
        contentSource: "raw",
      },
      image: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: false },
        contentSource: "raw",
      },
      binary: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: false },
        contentSource: "raw",
      },
      unknown: {
        component: StubRenderer,
        features: { toc: false, raw: false, headings: false, copyable: true },
        contentSource: "text",
      },
    },
  };
});

const defaultProps = {
  fileId: "abc123",
  fileName: "test.md",
  fileType: "markdown" as const,
  revision: 1,
  onFileOpened: vi.fn(),
  onHeadingsChange: vi.fn(),
  onContentRendered: vi.fn(),
  isTocOpen: false,
  onTocToggle: vi.fn(),
  onRemoveFile: vi.fn(),
  isWide: false,
};

describe("FileViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders text renderer for markdown type", async () => {
    render(<FileViewer {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("text-renderer")).toBeInTheDocument();
    });
  });

  it("renders raw renderer for pdf type", async () => {
    render(<FileViewer {...defaultProps} fileType="pdf" fileName="doc.pdf" />);
    await waitFor(() => {
      const el = screen.getByTestId("raw-renderer");
      expect(el).toBeInTheDocument();
      expect(el.textContent).toContain("/_/api/files/abc123/raw?v=1");
    });
  });

  it("clears headings for non-heading file types", async () => {
    render(<FileViewer {...defaultProps} fileType="pdf" fileName="doc.pdf" />);
    await waitFor(() => {
      expect(defaultProps.onHeadingsChange).toHaveBeenCalledWith([]);
    });
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd /vm-mo/internal/frontend && pnpm test src/components/FileViewer.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /vm-mo && git add internal/frontend/src/components/FileViewer.test.tsx && git commit -m "test: add FileViewer dispatcher tests"
```

---

## Phase 3: PDF Support

### Task 10: Install react-pdf

**Files:**
- Modify: `internal/frontend/package.json`

- [ ] **Step 1: Install react-pdf**

```bash
cd /vm-mo/internal/frontend && pnpm add react-pdf
```

- [ ] **Step 2: Verify install**

```bash
cd /vm-mo/internal/frontend && node -e "require('react-pdf'); console.log('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /vm-mo && git add internal/frontend/package.json internal/frontend/pnpm-lock.yaml && git commit -m "build: add react-pdf dependency"
```

---

### Task 11: Create PdfRenderer

**Files:**
- Create: `internal/frontend/src/renderers/PdfRenderer.tsx`
- Create: `internal/frontend/src/renderers/PdfRenderer.test.tsx`
- Modify: `internal/frontend/src/renderers/registry.ts`

- [ ] **Step 1: Write PdfRenderer test with mocked react-pdf**

Create `internal/frontend/src/renderers/PdfRenderer.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";

// Mock react-pdf since jsdom lacks canvas and Web Worker support.
vi.mock("react-pdf", () => ({
  Document: ({
    onLoadSuccess,
    children,
    loading,
  }: {
    file: string;
    onLoadSuccess: (pdf: { numPages: number }) => void;
    children: React.ReactNode;
    loading: React.ReactNode;
  }) => {
    // Simulate async load.
    setTimeout(() => onLoadSuccess({ numPages: 3 }), 0);
    return <div data-testid="pdf-document">{children}</div>;
  },
  Page: ({ pageNumber }: { pageNumber: number }) => (
    <div data-testid={`pdf-page-${pageNumber}`}>Page {pageNumber}</div>
  ),
  pdfjs: {
    GlobalWorkerOptions: { workerSrc: "" },
  },
}));

// Dynamic import for the lazy-loaded component.
const { PdfRenderer } = await import("./PdfRenderer");

describe("PdfRenderer", () => {
  const defaultProps = {
    fileId: "abc123",
    fileName: "doc.pdf",
    revision: 1,
    isRawView: false,
    onHeadingsChange: vi.fn(),
    onContentRendered: vi.fn(),
    contentSource: "raw" as const,
    rawUrl: "/_/api/files/abc123/raw?v=1",
  };

  it("renders PDF document with pages", async () => {
    render(
      <Suspense fallback={<div>Loading...</div>}>
        <PdfRenderer {...defaultProps} />
      </Suspense>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("pdf-document")).toBeInTheDocument();
    });
  });

  it("displays page count after load", async () => {
    render(
      <Suspense fallback={<div>Loading...</div>}>
        <PdfRenderer {...defaultProps} />
      </Suspense>,
    );

    await waitFor(() => {
      // After onLoadSuccess fires with numPages: 3, pages should render.
      expect(screen.getByTestId("pdf-page-1")).toBeInTheDocument();
    });
  });

  it("clears headings on mount", async () => {
    render(
      <Suspense fallback={<div>Loading...</div>}>
        <PdfRenderer {...defaultProps} />
      </Suspense>,
    );

    await waitFor(() => {
      expect(defaultProps.onHeadingsChange).toHaveBeenCalledWith([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /vm-mo/internal/frontend && pnpm test src/renderers/PdfRenderer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create PdfRenderer.tsx**

Create `internal/frontend/src/renderers/PdfRenderer.tsx`:

```typescript
import { useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import type { RawRendererProps } from "./registry";

// Configure pdf.js worker — loaded only when this module is imported (lazy).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export function PdfRenderer({
  rawUrl,
  onHeadingsChange,
  onContentRendered,
}: RawRendererProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [error, setError] = useState<string>("");

  // PDF has no headings.
  useEffect(() => {
    onHeadingsChange([]);
  }, [onHeadingsChange]);

  function onDocumentLoadSuccess(pdf: { numPages: number }) {
    setNumPages(pdf.numPages);
    setError("");
    onContentRendered?.();
  }

  function onDocumentLoadError(err: Error) {
    setError(`Failed to load PDF: ${err.message}`);
    onContentRendered?.();
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <Document
        file={rawUrl}
        onLoadSuccess={onDocumentLoadSuccess}
        onLoadError={onDocumentLoadError}
        loading={
          <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
            Loading PDF...
          </div>
        }
      >
        {Array.from({ length: numPages }, (_, i) => (
          <Page
            key={i + 1}
            pageNumber={i + 1}
            width={800}
            className="mb-4 shadow-md"
          />
        ))}
      </Document>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /vm-mo/internal/frontend && pnpm test src/renderers/PdfRenderer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /vm-mo && git add internal/frontend/src/renderers/PdfRenderer.tsx internal/frontend/src/renderers/PdfRenderer.test.tsx && git commit -m "feat: add PdfRenderer with react-pdf integration"
```

---

### Task 12: Create GenericRenderer and ImageRenderer

**Files:**
- Create: `internal/frontend/src/renderers/GenericRenderer.tsx`
- Create: `internal/frontend/src/renderers/GenericRenderer.test.tsx`
- Create: `internal/frontend/src/renderers/ImageRenderer.tsx`

- [ ] **Step 1: Write GenericRenderer test**

Create `internal/frontend/src/renderers/GenericRenderer.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GenericRenderer } from "./GenericRenderer";

describe("GenericRenderer", () => {
  const defaultProps = {
    fileId: "abc123",
    fileName: "archive.zip",
    revision: 1,
    isRawView: false,
    onHeadingsChange: vi.fn(),
    onContentRendered: vi.fn(),
    contentSource: "raw" as const,
    rawUrl: "/_/api/files/abc123/raw?v=1",
  };

  it("displays file name", () => {
    render(<GenericRenderer {...defaultProps} />);
    expect(screen.getByText("archive.zip")).toBeInTheDocument();
  });

  it("renders download link with raw URL", () => {
    render(<GenericRenderer {...defaultProps} />);
    const link = screen.getByRole("link", { name: /download/i });
    expect(link).toHaveAttribute("href", "/_/api/files/abc123/raw?v=1");
  });

  it("clears headings on mount", () => {
    render(<GenericRenderer {...defaultProps} />);
    expect(defaultProps.onHeadingsChange).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: Create GenericRenderer.tsx**

Create `internal/frontend/src/renderers/GenericRenderer.tsx`:

```typescript
import { useEffect } from "react";
import type { RawRendererProps } from "./registry";

export function GenericRenderer({
  fileName,
  rawUrl,
  onHeadingsChange,
  onContentRendered,
}: RawRendererProps) {
  useEffect(() => {
    onHeadingsChange([]);
  }, [onHeadingsChange]);

  useEffect(() => {
    onContentRendered?.();
  }, [onContentRendered]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-gh-text-secondary">
      <div className="text-4xl">📄</div>
      <div className="text-lg font-medium text-gh-text-primary">{fileName}</div>
      <div className="text-sm">This file appears to be binary and cannot be previewed.</div>
      <a
        href={rawUrl}
        download={fileName}
        className="mt-2 px-4 py-2 bg-gh-bg-sidebar border border-gh-border rounded-md text-gh-text-primary text-sm hover:bg-gh-bg-tertiary"
      >
        Download file
      </a>
    </div>
  );
}
```

- [ ] **Step 3: Create ImageRenderer.tsx**

Create `internal/frontend/src/renderers/ImageRenderer.tsx`:

```typescript
import { useEffect } from "react";
import type { RawRendererProps } from "./registry";

export function ImageRenderer({
  fileName,
  rawUrl,
  onHeadingsChange,
  onContentRendered,
}: RawRendererProps) {
  useEffect(() => {
    onHeadingsChange([]);
  }, [onHeadingsChange]);

  return (
    <div className="flex items-center justify-center p-4">
      <img
        src={rawUrl}
        alt={fileName}
        className="max-w-full h-auto"
        onLoad={() => onContentRendered?.()}
        onError={() => onContentRendered?.()}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd /vm-mo/internal/frontend && pnpm test src/renderers/GenericRenderer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /vm-mo && git add internal/frontend/src/renderers/GenericRenderer.tsx internal/frontend/src/renderers/GenericRenderer.test.tsx internal/frontend/src/renderers/ImageRenderer.tsx && git commit -m "feat: add GenericRenderer and ImageRenderer"
```

---

### Task 13: Wire All Renderers into Registry

**Files:**
- Modify: `internal/frontend/src/renderers/registry.ts`

- [ ] **Step 1: Update registry with real components**

Replace the placeholder imports and entries in `internal/frontend/src/renderers/registry.ts`:

```typescript
import { lazy, type ComponentType } from "react";
import type { FileType } from "../hooks/useApi";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { CodeRenderer } from "./CodeRenderer";
import { GenericRenderer } from "./GenericRenderer";
import { ImageRenderer } from "./ImageRenderer";

const PdfRenderer = lazy(() =>
  import("./PdfRenderer").then((m) => ({ default: m.PdfRenderer })),
);

// ... (keep all type definitions unchanged) ...

export const rendererRegistry: Record<FileType, RendererEntry> = {
  markdown: {
    component: MarkdownRenderer as ComponentType<RendererProps>,
    features: { toc: true, raw: true, headings: true, copyable: true },
    contentSource: "text",
  },
  code: {
    component: CodeRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
  pdf: {
    component: PdfRenderer as unknown as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  image: {
    component: ImageRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  binary: {
    component: GenericRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  unknown: {
    component: CodeRenderer as ComponentType<RendererProps>,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
};
```

Remove the `Placeholder` function — it is no longer needed.

- [ ] **Step 2: Run all frontend tests**

Run: `cd /vm-mo/internal/frontend && pnpm test`
Expected: PASS

- [ ] **Step 3: Run full build**

Run: `cd /vm-mo && make build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /vm-mo && git add internal/frontend/src/renderers/registry.ts && git commit -m "feat: wire all renderers into registry, remove placeholders"
```

---

### Task 14: End-to-End Verification

**Files:**
- Create: `testdata/sample.pdf`

- [ ] **Step 1: Add test PDF**

Create a minimal test PDF. You can generate one or download a small sample. Place it at `testdata/sample.pdf`.

```bash
cd /vm-mo && printf '%%PDF-1.0\n1 0 obj<</Pages 2 0 R>>endobj\n2 0 obj<</Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>' > testdata/sample.pdf
```

- [ ] **Step 2: Run full test suite**

Run: `cd /vm-mo && make test`
Expected: PASS — all Go and frontend tests pass.

- [ ] **Step 3: Run linters**

Run: `cd /vm-mo && make lint && cd internal/frontend && pnpm run lint`
Expected: PASS

- [ ] **Step 4: Manual E2E test**

Run: `cd /vm-mo && make dev ARGS="--foreground testdata/sample.pdf"`

Verify:
- PDF renders in the browser with page content visible
- No console errors
- Switching between PDF and markdown files works
- ToC panel hidden for PDF, shown for markdown
- Raw toggle hidden for PDF, shown for markdown
- Live-reload: modify a watched markdown file, confirm it updates

- [ ] **Step 5: Measure binary size impact**

```bash
cd /vm-mo && ls -lh mo
```

Compare with the pre-change binary size. Document the increase (expected ~1-2MB from pdfjs worker).

- [ ] **Step 6: Commit**

```bash
cd /vm-mo && git add testdata/sample.pdf && git commit -m "test: add sample PDF for manual testing"
```

---

## Post-Implementation Notes

### What's Deferred to Phase 4 (chore/file-type-polish)

These are documented in the spec but intentionally not in this plan:

1. Shared `extensions.json` manifest + `TestExtensionMapConsistency` cross-side test
2. Playwright E2E test for PDF rendering
3. `testdata/sample.png` for image testing
4. CLI `--help` description update
5. Accessibility improvements (`aria-label`, descriptive link text)

### Key Risks to Watch

1. **MarkdownViewer extraction (Task 6-8):** Highest risk. The 650-line file has tightly coupled state. If extraction introduces regressions, revert to Task 5's commit and re-extract more carefully.
2. **react-pdf worker loading (Task 11):** The `import.meta.url` pattern for the worker must work in both `pnpm dev` and `make build` modes. Test both early.
3. **Route disambiguation (Task 3):** The route coexistence test must pass before anything else depends on it.
