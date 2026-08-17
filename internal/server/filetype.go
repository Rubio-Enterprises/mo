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
