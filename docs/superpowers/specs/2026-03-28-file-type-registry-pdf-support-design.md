# File Type Registry & PDF Support

## Overview

Add a modular file type rendering system to mo, enabling support for non-markdown file types starting with PDF. The architecture introduces a file type registry pattern that maps file types to dedicated renderer components, making it straightforward to add new file types in the future (images, structured data, etc.) without modifying core dispatch logic.

## Requirements

- PDF files can be opened in mo (`mo file.pdf`) and rendered in the browser
- The rendering system is modular: each file type has a dedicated renderer component selected via a registry
- Binary files (PDF, images) are no longer rejected — they are accepted and served appropriately
- The backend detects file type from extension and communicates it to the frontend via the `FileEntry.type` field
- A new raw endpoint serves binary file content with correct `Content-Type` headers
- Existing markdown and code file rendering is unchanged (pure refactor, no behavioral difference)
- Live-reload works for all file types, including PDFs

## Non-Goals (v1)

- Drag-and-drop upload of binary files (requires `[]byte` content storage — future work)
- PDF text search, annotation, or editing
- PDF outline/bookmark extraction for ToC panel
- Image viewer with zoom/pan controls (placeholder only in v1)
- DOCX, PPTX, or other rich document format support

## File Type System

### Backend: Type Detection

New file `internal/server/filetype.go` with a named string type and constants:

```go
type FileType string

const (
    FileTypeMarkdown FileType = "markdown"
    FileTypeCode     FileType = "code"
    FileTypePDF      FileType = "pdf"
    FileTypeImage    FileType = "image"
    FileTypeBinary   FileType = "binary"
    FileTypeUnknown  FileType = "unknown"
)

func DetectFileType(path string) FileType
```

`DetectFileType` accepts a full file path (future-proofed for content sniffing) but in v1 only uses the extension. Extension mapping:

| Type | Extensions |
|------|-----------|
| markdown | `.md`, `.mdx`, `.markdown`, `.mdown`, `.mkdn`, `.mkd` |
| pdf | `.pdf` |
| image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.bmp` |
| code | ~40 extensions mirroring frontend `detectLanguage()` map (includes `.svg` — rendered as syntax-highlighted XML, not as an image) |
| unknown | Everything else (provisional — may be promoted to `binary` after content check) |

`FileTypeBinary` is never returned by `DetectFileType`. It is only produced by the unknown→binary promotion in `AddFile` when null bytes are detected in the file head.

Case-insensitive matching (`.PDF` and `.pdf` are equivalent).

### Backend: FileEntry Struct

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

The `Type` field is always set (no `omitempty`). Every file has a type.

### Backend: Revised AddFile Flow

```
AddFile(absPath, groupName)
  1. Check duplicates (existing logic, unchanged)
  2. fileType := DetectFileType(absPath)
  3. For all types: os.Stat + IsRegular() check (prevents directories/devices)
  4. Switch on fileType:
     - pdf, image:
         Skip head-read entirely. No binary check, no title extraction.
     - markdown:
         Read head (8KB). Binary check (null byte → reject). Extract title.
     - code, unknown:
         Read head (8KB). Binary check.
         If null byte AND type is "unknown" → promote to FileTypeBinary.
         If null byte AND type is "code" → reject (misnamed file).
         Title extraction runs for all text types (preserves existing
         behavior where code files with # comments get titles).
  5. Create FileEntry with Type field set
  6. Watch, notify (existing logic, unchanged)
```

Key behavioral change: unknown files with null bytes become `binary` type instead of being rejected. This lets mo accept any file.

### Backend: Backup Compatibility

Old backup files lack the `Type` field. On restore, `AddFile` is called for each path, which re-runs `DetectFileType` and the full flow. Type is re-detected automatically — no migration code needed.

## Content Serving

### New Endpoint: `GET /_/api/files/{id}/raw`

Serves the file entry itself as raw bytes with correct `Content-Type` header.

Handler: `handleFileServe` (new function, distinct from existing handler).

Behavior:

- Looks up `FileEntry` by ID
- For filesystem files: `http.ServeFile` (handles range requests, Last-Modified, ETag automatically)
- For uploaded files: returns 404 (binary uploads not supported in v1, consistent with existing `handleFileRaw` behavior)
- Content-Type derived from extension via Go's `mime.TypeByExtension()`
- Sets `X-Content-Type-Options: nosniff` header
- Works for all file types (not restricted to binary), though primarily used by binary renderers

### Handler Rename

Existing `handleFileRaw` → `handleFileAsset`. Function name only — URL path `GET /_/api/files/{id}/raw/{path...}` is unchanged. This distinguishes "serve the file itself" from "serve a sibling asset relative to the file's directory."

### Route Registration

```go
mux.HandleFunc("GET /_/api/files/{id}/raw", handleFileServe(state))       // new
mux.HandleFunc("GET /_/api/files/{id}/raw/{path...}", handleFileAsset(state)) // renamed
```

Handlers use the existing closure pattern (`handleFileServe(state)` returns `http.HandlerFunc`), matching the codebase convention — not methods on `*State`.

Go 1.22+ mux disambiguates: exact match (`/raw`) vs wildcard (`/raw/{path...}`). The `handleFileAsset` handler must guard against empty `{path...}` values (return 400). A route coexistence integration test must verify this disambiguation before other work depends on it.

### Content Endpoint Guard

`GET /_/api/files/{id}/content` gains a type check: if the file's type is `pdf`, `image`, or `binary`, return `415 Unsupported Media Type` instead of attempting to read and JSON-serialize binary content. This prevents corrupt responses if any client calls the text endpoint for a binary file. Text types (`markdown`, `code`, `unknown`) continue to serve `{ content: string, baseDir: string }` JSON as before.

### CSP Update

Add `worker-src 'self' blob:` to the Content-Security-Policy header. Required for react-pdf's pdfjs Web Worker.

### Cache-Busting

The frontend appends a revision counter as a query parameter: `/_/api/files/{id}/raw?v={revision}`. `http.ServeFile` ignores query parameters; the browser treats each revision as a distinct URL and bypasses its cache. This ensures live-reload works for binary files.

### Frontend URL Builder

```typescript
export function rawFileUrl(id: string, revision?: number): string {
  const base = `/_/api/files/${id}/raw`;
  return revision != null ? `${base}?v=${revision}` : base;
}
```

Named `rawFileUrl` (not `fetchFileRaw`) because it builds a URL string — no network request. Renderers pass this URL directly to their target elements (`react-pdf Document.file`, `<img src>`, etc.). No blob URLs (avoids memory leak risk, preserves range request support for pdfjs).

## Frontend Renderer Registry

### Type Definitions

```typescript
type FileType = "markdown" | "code" | "pdf" | "image" | "binary" | "unknown";

interface RendererFeatures {
  toc: boolean;        // Show ToC panel
  raw: boolean;        // Show raw view toggle
  headings: boolean;   // Extract headings for ToC/active heading tracking
  copyable: boolean;   // Show copy-to-clipboard button
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

// Discriminated union — no impossible states
type TextRendererProps = BaseRendererProps & {
  contentSource: "text";
  content: string;
};

type RawRendererProps = BaseRendererProps & {
  contentSource: "raw";
  rawUrl: string;
};

type RendererProps = TextRendererProps | RawRendererProps;

interface RendererEntry {
  component: React.ComponentType<RendererProps>;
  features: RendererFeatures;
  contentSource: "text" | "raw";
}
```

### Registry

```typescript
const PdfRenderer = React.lazy(() => import("./PdfRenderer"));

const rendererRegistry: Record<FileType, RendererEntry> = {
  markdown: {
    component: MarkdownRenderer,
    features: { toc: true, raw: true, headings: true, copyable: true },
    contentSource: "text",
  },
  code: {
    component: CodeRenderer,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
  pdf: {
    component: PdfRenderer,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  image: {
    component: ImageRenderer,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  binary: {
    component: GenericRenderer,
    features: { toc: false, raw: false, headings: false, copyable: false },
    contentSource: "raw",
  },
  unknown: {
    component: CodeRenderer,
    features: { toc: false, raw: false, headings: false, copyable: true },
    contentSource: "text",
  },
};
```

### FileViewer Dispatcher (`src/components/FileViewer.tsx`)

Replaces `MarkdownViewer` as the top-level content component. Responsibilities:

- Looks up registry entry by `file.type`
- Owns content fetching: text via `fetchFileContent()`, raw via `rawFileUrl()`
- Owns toolbar rendering: only shows toggles enabled by `features` (ToC, raw, copy)
- Owns `isRawView` state + toggle (passed to renderers with `features.raw`)
- Owns `<article>` wrapper with `isWide` class (renderers don't know about layout policy)
- Receives `isTocOpen`, `onTocToggle`, `onRemoveFile` as props from `App.tsx` (state remains in `App.tsx` since `TocPanel` is rendered there). `FileViewer` conditionally shows the ToC toggle button based on `features.toc` — never passes these to renderers.
- Wraps all renderers in `<Suspense fallback={<LoadingIndicator />}>` for lazy-loaded components
- Passes `onFileOpened` to renderers that need it (markdown link navigation)
- Non-heading renderers (pdf, image, binary, code) must call `onHeadingsChange([])` on mount to clear stale headings from previously viewed markdown files. `FileViewer` handles this: if `features.headings` is false, it calls `onHeadingsChange([])` itself rather than relying on the renderer.

### Renderer Components (`src/renderers/`)

| File | Source | Notes |
|------|--------|-------|
| `MarkdownRenderer.tsx` | Extracted from MarkdownViewer | rehype plugins, mermaid, frontmatter, checkboxes, hash scrolling |
| `CodeRenderer.tsx` | Extracted from MarkdownViewer | Shiki highlighting; derives language from `fileName` internally via existing `detectLanguage()` |
| `PdfRenderer.tsx` | New | `React.lazy` loaded; pdf.js worker configured inside module; continuous scroll with lazy page rendering |
| `GenericRenderer.tsx` | New | File metadata + download link via raw URL; for binary/unsupported files |
| `ImageRenderer.tsx` | New (placeholder in v1) | Basic `<img>` tag; zoom/fit controls deferred to future work |
| `registry.ts` | New | Registry definition, type exports |

Shared sub-components extracted from `MarkdownViewer.tsx` into their own files: `MermaidBlock`, `CodeBlock`, `HighlightedView`, `CodeBlockCopyButton`, `svgToPngBlob`.

### PdfRenderer Details

- Uses `react-pdf` (`Document` + `Page` components), which wraps Mozilla's pdfjs
- Receives `rawUrl` prop → passes to `Document file={rawUrl}`
- Renders pages lazily — only pages in or near the viewport are rendered (IntersectionObserver or similar)
- Respects the `isWide` layout via the `FileViewer` wrapper
- pdf.js worker configured inside the lazy module:

```typescript
import { pdfjs } from "react-pdf";
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();
```

**Bundle size note:** `pdfjs-dist` is substantial (~1.5MB minified for the worker). `React.lazy` + Vite code splitting ensures the worker chunk is only loaded when a PDF is actually viewed, not on initial page load. However, the chunk is still embedded in the Go binary via `go:embed`. The binary size increase should be measured after Phase 3 (`make build`, compare before/after). This is expected to be acceptable for a CLI tool.

### Frontend FileEntry Interface

```typescript
export interface FileEntry {
  name: string;
  id: string;
  path: string;
  title?: string;
  uploaded?: boolean;
  type: FileType;  // required, always set by backend
}
```

`isMarkdownFile()` is deleted from `filetype.ts`. `detectLanguage()` remains as a rendering utility for Shiki grammar selection. All type-routing decisions use `entry.type` from the backend. Unrecognized type strings from the backend are treated as `"unknown"`.

### Feature Flags: Static by Design

The `RendererFeatures` object is static per file type. This is an intentional simplification. If dynamic features are needed in the future (e.g., PDF outlines for ToC), the path forward is to let `RendererEntry.features` become a function `(file: FileEntry) => RendererFeatures`. This is documented as a known evolution point.

## Extension Map Consistency

A shared `extensions.json` manifest maps extensions to file types. Both sides import it:

- Go: `go:embed` in `internal/server/filetype.go`
- TypeScript: standard import in `src/utils/filetype.ts` (via Vite alias or relative path)

The manifest lives at `internal/server/extensions.json` (colocated with the Go consumer). The TypeScript side imports it via a relative path (`../../server/extensions.json`) or a Vite resolve alias — the exact mechanism is determined during Phase 4 implementation. The path resolution challenge between Go embed and TypeScript bundling is a known complexity.

A Go test (`TestExtensionMapConsistency`) verifies both sides agree on the file type for every extension. This prevents drift when extensions are added or changed.

Note: the frontend's `detectLanguage()` (extension → Shiki language name) remains independent — it is a rendering concern, not a classification concern. The shared manifest only covers type classification.

## Testing Strategy

### Backend Tests (`internal/server/`)

**`filetype_test.go` (new):**

- Known extensions map to correct types
- Unknown extensions → `FileTypeUnknown`
- No extension → `FileTypeUnknown`
- Case insensitivity (`.PDF`, `.Md`)
- Dot-only filenames (`.gitignore`)

**`server_test.go` (extended):**

AddFile flow:

- PDF file accepted (not rejected as binary)
- Image file accepted
- Unknown binary file promoted to `FileTypeBinary`
- Markdown with null bytes still rejected
- Code file with null bytes still rejected
- Directory named `something.pdf` rejected (IsRegular check)
- Symlink to PDF accepted (os.Stat resolves symlinks)
- Concurrent AddFile with same PDF does not create duplicates
- Type field set correctly on returned FileEntry for each type
- Title extracted for markdown, code, and unknown text files; skipped for pdf, image, binary

handleFileContent (guard):

- Returns 415 for PDF file type
- Returns 415 for image file type
- Returns 415 for binary file type
- Continues to return content JSON for markdown, code, unknown types

handleFileServe:

- Returns raw bytes with correct Content-Type (`.pdf` → `application/pdf`)
- Returns 404 for unknown file ID
- Returns 404 for uploaded files (consistent with existing pattern)
- `X-Content-Type-Options: nosniff` header present
- Cache-busting query param (`?v=2`) does not affect response content

handleFileAsset (renamed):

- Existing tests pass (behavior unchanged, URL unchanged)
- Empty path value returns 400

Route coexistence:

- `/_/api/files/{id}/raw` → handleFileServe
- `/_/api/files/{id}/raw/image.png` → handleFileAsset
- `/_/api/files/{id}/raw/` (trailing slash) handled safely

Glob patterns:

- Pattern matches PDF and image files, adds them successfully

### Frontend Tests (`internal/frontend/`)

**`src/renderers/registry.test.ts` (new):**

- Every `FileType` value has a registry entry
- `contentSource` values are valid
- Feature flags are boolean

**`src/utils/filetype.test.ts` (update):**

- Remove tests for deleted `isMarkdownFile()`
- Keep `detectLanguage()` tests unchanged

**`src/renderers/PdfRenderer.test.tsx` (new):**

- Mock `react-pdf` module (`vi.mock`) — jsdom lacks canvas and Web Worker support
- Test loading state rendered via Suspense fallback
- Test error handling (corrupt PDF, network error)
- Test page count display after successful load

**`src/components/FileViewer.test.tsx` (new):**

- Dispatches to correct renderer based on file type
- Text types: fetches content endpoint, passes `content` prop
- Raw types: builds URL via `rawFileUrl()`, passes `rawUrl` prop
- Toolbar toggles respect feature flags
- `isRawView` state managed and passed correctly
- Headings cleared (`onHeadingsChange([])`) when switching to a non-heading file type

**Playwright E2E (Phase 4):**

- Start mo in foreground mode with a test PDF
- Verify page loads and PDF canvas renders
- Verify live-reload: modify PDF on disk, confirm browser updates

### Cross-Side Consistency Test

Go test `TestExtensionMapConsistency` in `internal/server/filetype_test.go` loads the shared `extensions.json` and verifies the Go `DetectFileType` function agrees with the manifest for every entry.

## Migration Phases

Each phase is a separate branch and PR for clean rollback.

### Phase 1: Backend (`feat/file-type-backend`)

Additive changes, no frontend impact. Existing behavior preserved for text files.

1. Add `internal/server/filetype.go` with `DetectFileType` + `filetype_test.go` (hardcoded extension map; refactored to shared `extensions.json` in Phase 4)
2. Add `Type` field to `FileEntry` + rework binary check to be type-aware + update existing binary rejection tests (`TestAddFile_RejectsBinaryFile`, `TestHandleAddFile_RejectsBinaryFile`) — **single atomic commit**
3. Add `handleFileServe` endpoint + route registration + tests
4. Rename `handleFileRaw` → `handleFileAsset` (function name only, URL unchanged)
5. Update CSP header (`worker-src 'self' blob:`)
6. Add `IsRegular` check for binary types (pdf, image)
7. Guard `handleFileAsset` against empty path values
8. Add type guard to `handleFileContent` (return 415 for binary file types)

### Phase 2: Frontend Extraction (`refactor/file-viewer-extraction`)

Pure structural refactor. Identical user-facing behavior. No new features.

1. Extract `MarkdownRenderer` from `MarkdownViewer.tsx`
2. Extract `CodeRenderer` (existing `HighlightedView` path)
3. Extract shared sub-components (`MermaidBlock`, `CodeBlock`, `HighlightedView`, `CodeBlockCopyButton`, `svgToPngBlob`)
4. Create `src/renderers/registry.ts` + `FileViewer.tsx` dispatcher
5. Replace `MarkdownViewer` usage in `App.tsx` with `FileViewer`
6. Delete `isMarkdownFile()` from `filetype.ts`
7. Add `FileViewer.test.tsx` and `registry.test.ts`

**Gate before proceeding to Phase 3:**

- All existing tests pass (`make test`)
- Manual visual regression: sidebar, ToC, raw toggle, theme, width toggle, resize handles
- SSE live-reload verified (edit watched file, confirm browser updates)
- localStorage keys unchanged
- PR with before/after screenshots

### Phase 3: PDF Support (`feat/pdf-support`)

New feature, builds on Phase 2 infrastructure.

1. `pnpm add react-pdf`
2. Create `PdfRenderer.tsx` with `React.lazy`, pdf.js worker config, lazy page rendering
3. Add `GenericRenderer.tsx` for binary type (metadata + download link)
4. Add `ImageRenderer.tsx` (basic `<img>` placeholder)
5. Add `PdfRenderer.test.tsx` (mocked react-pdf)
6. Add `testdata/sample.pdf` for manual testing

### Phase 4: Polish (`chore/file-type-polish`)

1. Create shared `extensions.json` manifest
2. Add `TestExtensionMapConsistency` cross-side test
3. Playwright E2E test for PDF rendering
4. Add `testdata/sample.png` for manual testing
5. Update CLI `--help` description to mention supported file types
6. Basic accessibility: `aria-label` on PDF container, descriptive download link text in GenericRenderer
